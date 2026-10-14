import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicJson,publicValue,ensureDirectory,containedFile } from "./content-library.js";
import type { ContentInput,ContentJob,ContentJobResult,ProcessingMode } from "./content-types.js";
import {nextYoutubeCooldown,retryTimestamp,YOUTUBE_AUTOMATIC_RETRIES,type YoutubeCooldown} from "./content-youtube-retry.js";
interface QueueDocument { version:1; jobs:ContentJob[]; youtubeCooldown?:YoutubeCooldown; }
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code==="EPERM";}};
async function liveLock(file:string):Promise<boolean>{try{const data=JSON.parse(await fs.readFile(file,"utf8"));return Number.isInteger(data.pid)&&alive(data.pid);}catch{return false;}}
export const isContentWorkerActive=(root:string)=>liveLock(path.join(root,"worker.lock"));
/** Maintenance shares the worker mutex so file moves cannot race with downloads/checkpoints. */
export async function withContentMaintenance<T>(root:string,operation:()=>Promise<T>):Promise<T>{
  const release=await lock(root,"worker",1200);try{return await operation();}finally{await release();}
}
class ContentLockBusyError extends Error {}
/** Opportunistic imports must not wait for, or write alongside, an active worker. */
export async function tryContentMaintenance<T>(root:string,operation:()=>Promise<T>):Promise<{acquired:false}|{acquired:true;value:T}>{
  let release:()=>Promise<void>;
  try{release=await lock(root,"worker",0);}catch(error){if(error instanceof ContentLockBusyError)return {acquired:false};throw error;}
  try{return {acquired:true,value:await operation()};}finally{await release();}
}
async function lock(root:string,name:string,waitMs=8000):Promise<()=>Promise<void>>{
  await ensureDirectory(root);const file=path.join(root,`${name}.lock`),token=crypto.randomUUID(),deadline=Date.now()+waitMs;
  while(true){try{const handle=await fs.open(file,"wx");await handle.writeFile(JSON.stringify({pid:process.pid,token}));await handle.close();
      return async()=>{try{const data=JSON.parse(await fs.readFile(file,"utf8"));if(data.token===token)await fs.unlink(file);}catch{}};
    }catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
      // Do not remove a lock while its creator is writing the initial JSON.
      const stat=await fs.stat(file).catch(()=>undefined);if(stat&&Date.now()-stat.mtimeMs>1000&&!(await liveLock(file))){await fs.unlink(file).catch(()=>{});continue;}
      if(Date.now()>=deadline)throw new ContentLockBusyError(name==="worker"?"已有任务正在运行，请等待或先取消":"任务列表正忙，请重试");
      await new Promise(resolve=>setTimeout(resolve,25));
    }
  }
}
async function rawQueue(root:string):Promise<QueueDocument>{
  try{const file=path.join(root,"queue.json");if((await fs.stat(file)).size>8*1024*1024)throw new Error("任务列表过大");const data=JSON.parse(await fs.readFile(file,"utf8"));if(data.version!==1||!Array.isArray(data.jobs))throw new Error("任务列表格式无效");
    const cooldown=data.youtubeCooldown;
    if(cooldown!==undefined&&(!cooldown||retryTimestamp(cooldown.until)===undefined||!Number.isInteger(cooldown.failures)||cooldown.failures<0||cooldown.failures>YOUTUBE_AUTOMATIC_RETRIES+1||typeof cooldown.paused!=="boolean"||cooldown.paused!==(cooldown.failures>YOUTUBE_AUTOMATIC_RETRIES)))throw new Error("冷却记录无效");
    for(const job of data.jobs)if(job.retry!==undefined&&(!job.retry||job.retry.kind!=="youtube_rate_limit"||retryTimestamp(job.retry.notBefore)===undefined||!Number.isInteger(job.retry.attempts)||job.retry.attempts<0||job.retry.attempts>YOUTUBE_AUTOMATIC_RETRIES+1||typeof job.retry.automatic!=="boolean"||job.platform!=="youtube"))throw new Error("任务冷却记录无效");
    return data;
  }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return {version:1,jobs:[]};throw new Error("任务列表损坏，已保留原文件，请检查 queue.json");}
}
async function rawJobs(root:string):Promise<ContentJob[]>{return (await rawQueue(root)).jobs;}
async function mutate(root:string,fn:(jobs:ContentJob[],document:QueueDocument)=>void|Promise<void>):Promise<ContentJob[]>{const release=await lock(root,"queue");try{const document=await rawQueue(root);await fn(document.jobs,document);await atomicJson(path.join(root,"queue.json"),document);return document.jobs;}finally{await release();}}
/** History persistence and queue updates share exactly the same queue mutex. */
export async function withContentQueueTransaction<T>(root:string,operation:(jobs:ContentJob[])=>Promise<T>):Promise<T>{let result!:T;await mutate(root,async jobs=>{try{await containedFile(root,"queue.json");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}result=await operation(jobs);});return result;}
export async function enqueueInputs(root:string,inputs:ContentInput[]):Promise<ContentJob[]>{
  return (await enqueueInputsDetailed(root,inputs)).jobs;
}
export interface EnqueueResult { jobs:ContentJob[];addedCount:number;retriedCount:number;existingCount:number;focusJobId?:string; }
function applyYoutubeSchedule(job:ContentJob,document:QueueDocument,now:number,automatic=true):void {
  if(job.platform!=="youtube"||job.cancelRequested||!["queued","paused","waiting"].includes(job.state))return;
  const cooldown=document.youtubeCooldown;
  if(!cooldown)return;
  const until=new Date(Math.max(retryTimestamp(cooldown.until)!,retryTimestamp(job.retry?.notBefore)??0)).toISOString();
  if(!cooldown.paused&&Date.parse(until)<=now)return;
  job.state=cooldown.paused?"rate_limited":automatic?"waiting":"queued";
  job.retry={kind:"youtube_rate_limit",notBefore:until,attempts:cooldown.failures,automatic:automatic&&!cooldown.paused};
  job.stage=cooldown.paused?"自动恢复已暂停":"YouTube限流冷却";
  job.message=cooldown.paused?"连续429，已停止自动恢复；请检查YouTube网络或专用浏览器验证，再手动重试。已有资料保留":automatic?`冷却至 ${until}，功能窗口打开时自动继续（恢复 ${cooldown.failures}/${YOUTUBE_AUTOMATIC_RETRIES}）；已有资料保留`:`已加入队列，冷却至 ${until}；点击开始保存后安排恢复`;
  delete job.progress;
  delete job.finishedAt;
}
function queueRetry(job:ContentJob,document:QueueDocument,now=new Date().toISOString(),explicit=false):void{
  if(explicit&&job.platform==="youtube"&&document.youtubeCooldown?.paused){document.youtubeCooldown.paused=false;document.youtubeCooldown.failures=0;}
  job.state="queued";job.stage="等待重试";job.message="将复用已保存文件并补充缺失项";job.cancelRequested=false;job.updatedAt=now;job.queuedAt=now;delete job.startedAt;delete job.finishedAt;delete job.progress;
  if(explicit)delete job.retry;
  applyYoutubeSchedule(job,document,Date.parse(now),false);
}
export async function enqueueInputsDetailed(root:string,inputs:ContentInput[]):Promise<EnqueueResult>{
  if(!inputs.length)throw new Error("未找到支持的公网链接");if(inputs.length>100)throw new Error("一次最多加入100个链接，请分批处理");
  if(inputs.some(input=>input.processing!==undefined&&!["original","transcribe","full"].includes(input.processing)))throw new Error("处理模式无效");
  let addedCount=0,retriedCount=0,existingCount=0,focusJobId:string|undefined;
  const jobs=await mutate(root,(jobs,document)=>{for(const input of inputs){const key=`${input.platform}:${input.nativeId||input.canonicalUrl}`;
    const existing=jobs.find(job=>`${job.input.platform}:${job.input.nativeId||job.input.canonicalUrl}`===key);
    if(existing){focusJobId=existing.id;if(["cancelled","failed","partial","login_required","rate_limited"].includes(existing.state)||existing.state==="completed"&&input.processing!==undefined&&input.processing!==(existing.input.processing??"full")){const explicit=existing.state==="rate_limited";existing.input={...input,...(input.processing===undefined&&existing.input.processing?{processing:existing.input.processing}:{})};queueRetry(existing,document,undefined,explicit);retriedCount++;}else {if(input.platform==="local"&&["queued","paused"].includes(existing.state))existing.input={...input,...(input.processing===undefined&&existing.input.processing?{processing:existing.input.processing}:{})};existingCount++;}continue;}
    if(jobs.length>=1000)throw new Error("任务列表达到1000条上限");const now=new Date().toISOString();focusJobId=crypto.randomUUID();const added:ContentJob={id:focusJobId,input,platform:input.platform,...(input.platform==="local"&&input.localFileName?{title:input.localFileName}:{}),state:"queued",stage:"等待",message:"已加入队列",createdAt:now,updatedAt:now,queuedAt:now,attempts:0};applyYoutubeSchedule(added,document,Date.parse(now),false);jobs.push(added);addedCount++;}});
  return {jobs,addedCount,retriedCount,existingCount,focusJobId};
}
export async function getJobs(root:string,recover=true):Promise<ContentJob[]>{
  const jobs=await rawJobs(root);if(recover&&jobs.some(j=>j.state==="running")&&!(await liveLock(path.join(root,"worker.lock")))){
    return mutate(root,async items=>{if(await liveLock(path.join(root,"worker.lock")))return;for(const job of items)if(job.state==="running"){job.state="paused";job.stage="可恢复";job.message="上次处理已中断，点击开始保存可继续";job.updatedAt=new Date().toISOString();}});
  }return jobs;
}
export async function updateJob(root:string,id:string,patch:Partial<ContentJob>):Promise<void>{await mutate(root,jobs=>{const job=jobs.find(j=>j.id===id);if(!job)throw new Error("任务不存在");Object.assign(job,patch,{id:job.id,updatedAt:new Date().toISOString()});});}
export async function cancelJob(root:string,id:string):Promise<void>{await mutate(root,jobs=>{const job=jobs.find(j=>j.id===id);if(!job)throw new Error("任务不存在");if(["completed","cancelled"].includes(job.state))return;job.cancelRequested=true;const now=new Date().toISOString();if(job.state!=="running"){job.state="cancelled";job.finishedAt=now;}job.message="正在取消；已保存资料将保留";job.updatedAt=now;});}
export async function retryJob(root:string,id:string,processing?:ProcessingMode):Promise<void>{if(processing!==undefined&&!["original","transcribe","full"].includes(processing))throw new Error("处理模式无效");await mutate(root,(jobs,document)=>{const job=jobs.find(j=>j.id===id);if(!job)throw new Error("任务不存在");if(job.state==="running")throw new Error("任务仍在运行，请先取消或等待");if(processing!==undefined)job.input.processing=processing;queueRetry(job,document,undefined,true);});}
export function contentQueueSchedule(jobs:ContentJob[],now=Date.now()){
  const active=jobs.filter(job=>!job.cancelRequested);
  const waiting=active.filter(job=>job.state==="waiting"&&job.retry?.automatic);
  const deadlines=waiting.map(job=>retryTimestamp(job.retry!.notBefore)!).filter(time=>Number.isFinite(time));
  return {readyCount:active.filter(job=>["queued","paused"].includes(job.state)&&(retryTimestamp(job.retry?.notBefore)??0)<=now||job.state==="waiting"&&job.retry?.automatic&&retryTimestamp(job.retry.notBefore)!<=now).length,
    canStartCount:active.filter(job=>["queued","paused"].includes(job.state)||job.state==="waiting"&&job.retry?.automatic&&retryTimestamp(job.retry.notBefore)!<=now).length,
    waitingCount:waiting.length,rateLimitedCount:active.filter(job=>job.state==="rate_limited").length,...(deadlines.length?{nextWakeAt:new Date(Math.min(...deadlines)).toISOString()}:{})};
}
export async function runJobs(root:string,handler:(job:ContentJob,signal:AbortSignal)=>Promise<ContentJobResult>,onReady?:()=>void,options:{now?:()=>number;scheduledOnly?:boolean}={}):Promise<ContentJob[]>{
  const now=options.now??Date.now;
  await getJobs(root);const release=await lock(root,"worker",1200);
  try{onReady?.();for(;;){let selected:ContentJob|undefined;
    await mutate(root,(items,document)=>{for(const value of items)if(!options.scheduledOnly||value.state==="waiting"&&value.retry?.automatic)applyYoutubeSchedule(value,document,now());const item=items.find(value=>!value.cancelRequested&&(!options.scheduledOnly&&["queued","paused"].includes(value.state)||value.state==="waiting"&&value.retry?.automatic&&retryTimestamp(value.retry.notBefore)!<=now()));if(!item)return;item.state="running";item.stage="准备";item.message="正在处理";item.attempts++;item.updatedAt=new Date().toISOString();item.startedAt=item.updatedAt;delete item.finishedAt;selected=structuredClone(item);});
    const job=selected;if(!job)break;
    const controller=new AbortController();let checking=false;
    const timer=setInterval(()=>{if(checking)return;checking=true;void rawJobs(root).then(items=>{if(items.find(item=>item.id===job.id)?.cancelRequested)controller.abort();}).finally(()=>{checking=false;}).catch(()=>{});},150);
    try{const result=await handler(job,controller.signal);
      await mutate(root,(items,document)=>{const current=items.find(item=>item.id===job.id);if(!current)throw new Error("任务不存在");
        const {youtubeRateLimit,youtubeAccessRestored,...patch}=result;
        if(job.platform==="youtube"&&youtubeRateLimit)document.youtubeCooldown=nextYoutubeCooldown(document.youtubeCooldown,youtubeRateLimit.retryAfter,now());
        const finishedAt=new Date().toISOString();
        if(controller.signal.aborted||current.cancelRequested)Object.assign(current,{state:"cancelled",stage:"已取消",message:"已保留保存结果，可重试继续",finishedAt});
        else {Object.assign(current,patch,{state:patch.state??"partial",stage:patch.stage??"处理结束",finishedAt});
          if(job.platform==="youtube"&&youtubeRateLimit){current.state="queued";applyYoutubeSchedule(current,document,now());}
          else if(job.platform==="youtube"&&youtubeAccessRestored){delete document.youtubeCooldown;delete current.retry;}
          else if(current.state!=="waiting")delete current.retry;
        }
        current.updatedAt=finishedAt;
      });
    }catch(error){await mutate(root,items=>{const current=items.find(item=>item.id===job.id);if(!current)throw new Error("任务不存在");const cancelled=controller.signal.aborted||(error instanceof Error&&error.name==="AbortError")||current.cancelRequested;const finishedAt=new Date().toISOString();Object.assign(current,{state:cancelled?"cancelled":"failed",stage:cancelled?"已取消":"失败",message:cancelled?"已取消，已保存文件保留":publicValue(error instanceof Error?error.message:"处理失败"),finishedAt,updatedAt:finishedAt});delete current.retry;delete current.progress;});}
    finally{clearInterval(timer);}
  }return rawJobs(root);}finally{await release();}
}

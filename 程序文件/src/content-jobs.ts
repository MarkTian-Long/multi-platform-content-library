import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicJson,publicValue,ensureDirectory } from "./content-library.js";
import type { ContentInput,ContentJob } from "./content-types.js";
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code==="EPERM";}};
async function liveLock(file:string):Promise<boolean>{try{const data=JSON.parse(await fs.readFile(file,"utf8"));return Number.isInteger(data.pid)&&alive(data.pid);}catch{return false;}}
export const isContentWorkerActive=(root:string)=>liveLock(path.join(root,"worker.lock"));
async function lock(root:string,name:string,waitMs=8000):Promise<()=>Promise<void>>{
  await ensureDirectory(root);const file=path.join(root,`${name}.lock`),token=crypto.randomUUID(),deadline=Date.now()+waitMs;
  while(true){try{const handle=await fs.open(file,"wx");await handle.writeFile(JSON.stringify({pid:process.pid,token}));await handle.close();
      return async()=>{try{const data=JSON.parse(await fs.readFile(file,"utf8"));if(data.token===token)await fs.unlink(file);}catch{}};
    }catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
      // Do not remove a lock while its creator is writing the initial JSON.
      const stat=await fs.stat(file).catch(()=>undefined);if(stat&&Date.now()-stat.mtimeMs>1000&&!(await liveLock(file))){await fs.unlink(file).catch(()=>{});continue;}
      if(Date.now()>=deadline)throw new Error(name==="worker"?"已有任务正在运行，请等待或先取消":"任务列表正忙，请重试");
      await new Promise(resolve=>setTimeout(resolve,25));
    }
  }
}
async function rawJobs(root:string):Promise<ContentJob[]>{
  try{const file=path.join(root,"queue.json");if((await fs.stat(file)).size>8*1024*1024)throw new Error("任务列表过大");const data=JSON.parse(await fs.readFile(file,"utf8"));if(data.version!==1||!Array.isArray(data.jobs))throw new Error("任务列表格式无效");return data.jobs;
  }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return [];throw new Error("任务列表损坏，已保留原文件，请检查 queue.json");}
}
async function mutate(root:string,fn:(jobs:ContentJob[])=>void|Promise<void>):Promise<ContentJob[]>{const release=await lock(root,"queue");try{const jobs=await rawJobs(root);await fn(jobs);await atomicJson(path.join(root,"queue.json"),{version:1,jobs});return jobs;}finally{await release();}}
export async function enqueueInputs(root:string,inputs:ContentInput[]):Promise<ContentJob[]>{
  if(!inputs.length)throw new Error("未找到支持的公网链接");if(inputs.length>100)throw new Error("一次最多加入100个链接，请分批处理");
  return mutate(root,jobs=>{for(const input of inputs){const key=`${input.platform}:${input.nativeId||input.canonicalUrl}`;
    if(jobs.some(job=>`${job.input.platform}:${job.input.nativeId||job.input.canonicalUrl}`===key))continue;
    if(jobs.length>=1000)throw new Error("任务列表达到1000条上限");const now=new Date().toISOString();jobs.push({id:crypto.randomUUID(),input,platform:input.platform,state:"queued",stage:"等待",message:"已加入队列",createdAt:now,updatedAt:now,attempts:0});}});
}
export async function getJobs(root:string,recover=true):Promise<ContentJob[]>{
  const jobs=await rawJobs(root);if(recover&&jobs.some(j=>j.state==="running")&&!(await liveLock(path.join(root,"worker.lock")))){
    return mutate(root,async items=>{if(await liveLock(path.join(root,"worker.lock")))return;for(const job of items)if(job.state==="running"){job.state="paused";job.stage="可恢复";job.message="上次处理已中断，点击开始保存可继续";job.updatedAt=new Date().toISOString();}});
  }return jobs;
}
export async function updateJob(root:string,id:string,patch:Partial<ContentJob>):Promise<void>{await mutate(root,jobs=>{const job=jobs.find(j=>j.id===id);if(!job)throw new Error("任务不存在");Object.assign(job,patch,{id:job.id,updatedAt:new Date().toISOString()});});}
export async function cancelJob(root:string,id:string):Promise<void>{await mutate(root,jobs=>{const job=jobs.find(j=>j.id===id);if(!job)throw new Error("任务不存在");if(["completed","cancelled"].includes(job.state))return;job.cancelRequested=true;if(job.state!=="running")job.state="cancelled";job.message="正在取消；已保存资料将保留";job.updatedAt=new Date().toISOString();});}
export async function retryJob(root:string,id:string):Promise<void>{await mutate(root,jobs=>{const job=jobs.find(j=>j.id===id);if(!job)throw new Error("任务不存在");if(job.state==="running")throw new Error("任务仍在运行，请先取消或等待");job.state="queued";job.stage="等待重试";job.message="将复用已保存文件并补充缺失项";job.cancelRequested=false;job.updatedAt=new Date().toISOString();});}
export async function runJobs(root:string,handler:(job:ContentJob,signal:AbortSignal)=>Promise<Partial<ContentJob>>,onReady?:()=>void):Promise<ContentJob[]>{
  await getJobs(root);const release=await lock(root,"worker",1200);
  try{onReady?.();for(;;){let selected:ContentJob|undefined;
    await mutate(root,items=>{const item=items.find(value=>["queued","paused"].includes(value.state)&&!value.cancelRequested);if(!item)return;item.state="running";item.stage="准备";item.message="正在处理";item.attempts++;item.updatedAt=new Date().toISOString();selected=structuredClone(item);});
    const job=selected;if(!job)break;
    const controller=new AbortController();let checking=false;
    const timer=setInterval(()=>{if(checking)return;checking=true;void rawJobs(root).then(items=>{if(items.find(item=>item.id===job.id)?.cancelRequested)controller.abort();}).finally(()=>{checking=false;}).catch(()=>{});},150);
    try{const result=await handler(job,controller.signal);const current=(await rawJobs(root)).find(item=>item.id===job.id);
      if(controller.signal.aborted||current?.cancelRequested)await updateJob(root,job.id,{state:"cancelled",stage:"已取消",message:"已保留保存结果，可重试继续"});
      else await updateJob(root,job.id,{...result,state:result.state??"partial",stage:"处理结束"});
    }catch(error){const cancelled=controller.signal.aborted||(error instanceof Error&&error.name==="AbortError")||(await rawJobs(root)).find(item=>item.id===job.id)?.cancelRequested;await updateJob(root,job.id,{state:cancelled?"cancelled":"failed",stage:cancelled?"已取消":"失败",message:cancelled?"已取消，已保存文件保留":publicValue(error instanceof Error?error.message:"处理失败")});}
    finally{clearInterval(timer);}
  }return rawJobs(root);}finally{await release();}
}

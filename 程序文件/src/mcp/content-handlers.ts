import path from "node:path";
import fs from "node:fs/promises";
import {spawn} from "node:child_process";
import {runLinkCli} from "../link-cli.js";
import {runtimeDirectory,contentRoot} from "../content-runtime.js";
import {isContentWorkerActive} from "../content-jobs.js";
import type {ProcessingMode} from "../content-types.js";
const validProcessing=(value:unknown)=>value===undefined||value==="original"||value==="transcribe"||value==="full";

/** Resolve only after the worker has acquired the durable queue lock. */
export async function startContentWorker(runtimeRoot:string,root:string):Promise<void>{
  if(await isContentWorkerActive(root))return;
  const entry=path.join(runtimeRoot,"dist","link-cli.js");
  if(!await fs.stat(entry).then(s=>s.isFile(),()=>false))throw new Error("处理程序尚未构建，请先在程序文件目录运行 npm run build；链接仍保留在队列");
  await new Promise<void>((resolve,reject)=>{
    const worker=spawn(process.execPath,[entry,"work"],{cwd:runtimeRoot,env:{...process.env,WECHAT_ARTICLE_READER_ROOT:runtimeRoot,CONTENT_LIBRARY_ROOT:root},stdio:["ignore","ignore","ignore","ipc"],windowsHide:true});
    let settled=false;
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);worker.removeAllListeners("message");worker.removeAllListeners("exit");if(worker.connected)worker.disconnect();worker.unref();error?reject(error):resolve();};
    const timer=setTimeout(()=>finish(new Error("后台处理程序未确认启动；链接已入队，可从窗口开始保存")),10000);
    worker.on("message",message=>{if(message&&typeof message==="object"&&"type" in message&&message.type==="link-worker-ready")finish();});
    worker.once("error",error=>finish(error));
    worker.once("exit",code=>{void isContentWorkerActive(root).then(active=>finish(active?undefined:new Error(`后台处理程序在启动前退出（${code}）；链接仍保留在队列`)));});
  });
}

/** Tasks run in the app-owned queue; this never reads a default browser profile. */
export async function captureLink(input:{text:string;start?:boolean;processing?:ProcessingMode}){
  if(!input||typeof input.text!=="string"||input.start!==undefined&&typeof input.start!=="boolean"||!validProcessing(input.processing))return {ok:false,message:"链接文字、start或processing参数无效；start需要明确布尔值"};
  const result=await runLinkCli(["enqueue",...(input.processing!==undefined?["--processing",String(input.processing)]:[]),input.text]);if(result.ok&&input.start!==false){
    if(result.readyCount===0&&result.canStartCount===0)return {...result,workerStarted:false};
    const runtimeRoot=runtimeDirectory();try{await startContentWorker(runtimeRoot,contentRoot(runtimeRoot));return {...result,workerStarted:true,message:`${result.message}；后台处理程序已就绪，请查询每项任务结果`};}
    catch(error){return {...result,ok:false,queued:true,workerStarted:false,message:error instanceof Error?error.message:"后台处理程序启动失败，链接仍保留在队列"};}
  }return result;
}
export const findSavedContent=(query:string,filter:{tag?:string;favoritesOnly?:boolean}={})=>runLinkCli(["list",...(Object.keys(filter).length?["--filter",JSON.stringify(filter)]:[]),query]);
export const readSavedContent=(id:string,offset=0,limit=16000)=>runLinkCli(["read",id,String(offset),String(limit)]);
export const getCaptureJobs=()=>runLinkCli(["jobs"]);
export const getContentDetails=(id:string)=>runLinkCli(["details",id]);
export const getTranscriptEdition=(id:string,sourceAssetId?:string)=>runLinkCli(["transcript-read",id,...(sourceAssetId?[sourceAssetId]:[])]);
export async function putTranscriptEdition(id:string,input:{sourceAssetId:string;text:string;expectedSha256:string}) {
  try {const {saveTranscriptEdition}=await import("../content-transcript-edit.js");return {ok:true,message:"校订稿已保存；机器原稿保留",...await saveTranscriptEdition(contentRoot(runtimeDirectory()),id,input)};}
  catch(error){return {ok:false,message:error instanceof Error?error.message:"保存失败"};}
}
export async function importContentFiles(input:{paths:string[];encoding?:"utf-8"|"gb18030";processing?:ProcessingMode;start?:boolean}) {
  if(!input||!Array.isArray(input.paths)||input.paths.length<1||input.paths.length>100||input.paths.some(file=>typeof file!=="string")||input.start!==undefined&&typeof input.start!=="boolean"||!validProcessing(input.processing)||input.encoding!==undefined&&input.encoding!=="utf-8"&&input.encoding!=="gb18030")return {ok:false,message:"文件列表、start、encoding或processing参数无效"};
  const result=await runLinkCli(["import",...(input.processing!==undefined?["--processing",String(input.processing)]:[]),...(input.encoding?["--encoding",input.encoding]:[]),...input.paths]);
  if(!result.ok||input.start===false||result.readyCount===0&&result.canStartCount===0)return result;
  try {const runtimeRoot=runtimeDirectory();await startContentWorker(runtimeRoot,contentRoot(runtimeRoot));return {...result,workerStarted:true};}catch(error){return {...result,ok:false,queued:true,workerStarted:false,message:error instanceof Error?error.message:"后台启动失败"};}
}
export const organizeSavedContent=(id:string,patch?:{tags?:string[];favorite?:boolean})=>runLinkCli(["organize",id,...(patch?[JSON.stringify(patch)]:[])]);
export const exportSavedContent=(id:string,format:"zip"|"directory"="zip")=>runLinkCli([format==="zip"?"export-zip":"export",id]);
export const archiveSavedJobs=(ids:string[])=>runLinkCli(["archive-jobs",...ids]);
export const findArchivedJobs=()=>runLinkCli(["history"]);
export const restoreSavedJobs=(ids:string[])=>runLinkCli(["restore-jobs",...ids]);
export const manageSavedLogs=(action:string,options?:Record<string,unknown>,archiveId?:string)=>runLinkCli(["logs",action,...(action==="restore"?[archiveId??""]:options?[JSON.stringify(options)]:[])]);

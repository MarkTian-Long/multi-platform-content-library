import path from "node:path";
import fs from "node:fs/promises";
import {spawn} from "node:child_process";
import {runLinkCli} from "../link-cli.js";
import {runtimeDirectory,contentRoot} from "../content-service.js";
import {isContentWorkerActive} from "../content-jobs.js";

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
export async function captureLink(input:{text:string;start?:boolean}){
  const result=await runLinkCli(["enqueue",input.text]);if(result.ok&&input.start!==false){
    const runtimeRoot=runtimeDirectory();try{await startContentWorker(runtimeRoot,contentRoot(runtimeRoot));return {...result,workerStarted:true,message:"链接已入队，后台处理程序已就绪；请查询每项任务结果"};}
    catch(error){return {...result,ok:false,queued:true,workerStarted:false,message:error instanceof Error?error.message:"后台处理程序启动失败，链接仍保留在队列"};}
  }return result;
}
export const findSavedContent=(query:string)=>runLinkCli(["list",query]);
export const readSavedContent=(id:string,offset=0,limit=16000)=>runLinkCli(["read",id,String(offset),String(limit)]);
export const getCaptureJobs=()=>runLinkCli(["jobs"]);

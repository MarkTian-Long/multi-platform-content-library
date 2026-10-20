import fs from "node:fs/promises";
import { containedFile } from "./content-library.js";
export async function inheritedArticleWorker(root:string,env:NodeJS.ProcessEnv=process.env,parentPid=process.ppid):Promise<boolean>{
  if(env.CONTENT_LIBRARY_NATIVE_CAPTURE!=="1"||!env.CONTENT_LIBRARY_PARENT_WORKER_TOKEN)return false;
  try{const file=await containedFile(root,"worker.lock");if((await fs.stat(file)).size>4096)return false;const value=JSON.parse(await fs.readFile(file,"utf8"));return Number.isSafeInteger(value.pid)&&value.pid>0&&value.pid===parentPid&&typeof value.token==="string"&&/^[a-f0-9-]{36}$/i.test(value.token)&&value.token===env.CONTENT_LIBRARY_PARENT_WORKER_TOKEN;}catch{return false;}
}
export async function ownedArticleWorkerToken(root:string):Promise<string|undefined>{
  try{const value=JSON.parse(await fs.readFile(await containedFile(root,"worker.lock"),"utf8"));return value.pid===process.pid&&typeof value.token==="string"?value.token:undefined;}catch{return undefined;}
}

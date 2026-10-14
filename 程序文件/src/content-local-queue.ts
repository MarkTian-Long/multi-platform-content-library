import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { containedFile } from "./content-library.js";
import { enqueueInputsDetailed } from "./content-jobs.js";
import type { ContentInput, ProcessingMode } from "./content-types.js";
import { localImportFormat,localImportByteLimit } from "./content-local-import.js";
import { localDiagnosticError } from "./content-local-diagnostics.js";

const stamp=(stat:Awaited<ReturnType<typeof fs.stat>>)=>`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
/** Identity inspection performs no copy; the worker checks these bytes again when importing. */
export async function localFileInput(file:string,encoding?:"utf-8"|"gb18030"):Promise<ContentInput>{
  try {
  if(!path.isAbsolute(file)||/^\\\\|^\/\//.test(file)||/[\x00-\x1f]/.test(file))throw new Error("请选择本机绝对文件路径，网络和设备路径暂不支持");
  const extension=path.extname(file).toLowerCase();
  const format=localImportFormat(extension);
  if(!format)throw new Error("该本地文件类型暂不支持，当前可导入文字、HTML、PDF、DOCX、图片和音视频");
  const source=await containedFile(path.dirname(file),path.basename(file)),before=await fs.stat(source);
  const maximum=localImportByteLimit(extension,{maxTextBytes:4*1024*1024,maxMediaBytes:2*1024*1024*1024});
  if(!before.size||before.size>maximum)throw new Error(`文件为空或超过 ${maximum/1024/1024} MiB 导入上限`);
  const hash=createHash("sha256");let bytes=0;for await(const chunk of createReadStream(source)){bytes+=chunk.length;if(bytes>maximum)throw new Error("检查期间源文件增长并超过上限，请等写入结束后重新导入");hash.update(chunk);}
  if(stamp(await fs.stat(await containedFile(path.dirname(file),path.basename(file))))!==stamp(before))throw new Error("检查期间源文件发生变化，请重新导入");
  const sha256=hash.digest("hex");
  const nativeId=`${format}:${sha256}`,url=`local://sha256/${format}/${sha256}`;
  return {platform:"local",nativeId,url,canonicalUrl:url,localPath:source,localFileName:path.basename(file),...(encoding?{localTextEncoding:encoding}:{})};
  }catch(error){throw localDiagnosticError(error,file);}
}
export async function enqueueLocalFiles(root:string,files:string[],encoding?:"utf-8"|"gb18030",processing?:ProcessingMode){
  if(!files.length||files.length>100)throw new Error("请一次选择 1 到 100 个本地文件");
  const inputs:ContentInput[]=[];for(const file of files)inputs.push({...await localFileInput(file,encoding),...(processing?{processing}:{})});
  return enqueueInputsDetailed(root,inputs);
}

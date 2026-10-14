import path from "node:path";
import { publicValue } from "./content-library.js";

/** Diagnostics only: never redact or rewrite user text to hide a selected path. */
export function localDiagnostic(error:unknown,selectedPath?:string):string{
  const code=typeof error==="object"&&error&&"code" in error?String(error.code):"";
  const filesystem:Record<string,string>={ENOENT:"所选文件或处理所需文件已不存在，请重新选择；已存资料保留",ENOTDIR:"所选文件的目录已变化，请重新选择",EACCES:"无法读取所选文件，请检查本机文件权限",EPERM:"无法访问所选文件，请检查文件占用或权限",EISDIR:"请选择普通文件",EBUSY:"所选文件正被占用，请稍后重试"};
  if(filesystem[code])return filesystem[code];
  const message=error instanceof Error?error.message:"本地文件处理未完成";
  const normalized=message.replaceAll("\\\\","\\").replaceAll("/","\\").toLowerCase();
  if(selectedPath&&[selectedPath,path.dirname(selectedPath)].some(value=>value.length>3&&normalized.includes(value.replaceAll("/","\\").toLowerCase())))return "本地文件处理未完成，请检查所选文件后重试；已存资料保留";
  return publicValue(message);
}
export function localDiagnosticError(error:unknown,selectedPath?:string):Error{
  const safe=new Error(localDiagnostic(error,selectedPath));
  if(error instanceof Error)safe.name=error.name;
  return safe;
}

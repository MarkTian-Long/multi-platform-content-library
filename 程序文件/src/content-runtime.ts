import path from "node:path";
import { fileURLToPath } from "node:url";

/** Keep queue controls independent from browser/media modules and their startup cost. */
export function runtimeDirectory():string{return process.env.WECHAT_ARTICLE_READER_ROOT?.trim()||path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");}
export function contentRoot(runtimeRoot=runtimeDirectory()):string{
  const configured=process.env.CONTENT_LIBRARY_ROOT?.trim();
  if(configured&&!path.isAbsolute(configured))throw new Error("CONTENT_LIBRARY_ROOT 必须使用绝对目录，例如 D:\\资料库");
  return configured?path.resolve(configured):path.resolve(runtimeRoot,"..","资料库");
}

import type { ContentInput,ContentJob,ContentContext,CapturedContent } from "./content-types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath,pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { parseContentLinks,resolveContentInput } from "./content-input.js";
import { acquireContent } from "./content-acquisition.js";
import { enrichContent } from "./content-enrichment.js";
import { runContentTool } from "./content-tools.js";
import { contentDirectory,contentIdentity,containedFile,fileHash,findContent,listManifests,saveContent,publicValue,ensureDirectory,writableFile } from "./content-library.js";
import { getJobs,runJobs,updateJob } from "./content-jobs.js";
import { findArticles,readArticle,type ArticleManifest } from "./article-library.js";
import { resolveLibraryRoot } from "./config.js";
import { resolveEdgeExecutable } from "./url-policy.js";
export function runtimeDirectory():string{return process.env.WECHAT_ARTICLE_READER_ROOT?.trim()||path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");}
export function contentRoot(runtimeRoot=runtimeDirectory()):string{return process.env.CONTENT_LIBRARY_ROOT?.trim()||path.resolve(runtimeRoot,"..","资料库");}
export interface ServiceDeps { resolve?:(input:ContentInput,signal?:AbortSignal)=>Promise<ContentInput>; acquire?:(input:ContentInput,context:ContentContext)=>Promise<CapturedContent>;enrich?:(record:CapturedContent,context:ContentContext)=>Promise<CapturedContent>;pdf?:(directory:string,signal?:AbortSignal)=>Promise<string|undefined>; }

export async function generateContentPdf(directory:string,signal?:AbortSignal):Promise<string|undefined>{
  if(signal?.aborted)throw new DOMException("已取消","AbortError");const browser=await chromium.launch({executablePath:resolveEdgeExecutable(),headless:true});
  const abort=()=>{void browser.close().catch(()=>{});};signal?.addEventListener("abort",abort,{once:true});
  const temporary=await writableFile(directory,"reading.pending.pdf");
  try{const page=await browser.newPage();await page.route(/^https?:\/\//,route=>route.abort());await page.goto(pathToFileURL(await containedFile(directory,"reading.html")).toString(),{waitUntil:"load",timeout:20000});
    await page.evaluate(()=>{document.querySelectorAll("img").forEach(image=>{image.loading="eager";});});
    await page.pdf({path:temporary,format:"A4",printBackground:true,margin:{top:"16mm",bottom:"16mm",left:"16mm",right:"16mm"}});
    const handle=await fs.open(temporary,"r");const signature=Buffer.alloc(5);try{await handle.read(signature,0,5,0);}finally{await handle.close();}
    if(signature.toString()!=="%PDF-")throw new Error("PDF格式校验失败");await fs.rename(temporary,path.join(directory,"reading.pdf"));return "reading.pdf";
  }finally{signal?.removeEventListener("abort",abort);await browser.close().catch(()=>{});await fs.unlink(temporary).catch(()=>{});}
}
async function copyAsset(sourceDir:string,relative:string,stage:string):Promise<void>{
  const source=await containedFile(sourceDir,relative);const target=await writableFile(stage,relative);
  if(source!==target)await fs.copyFile(source,target);
}
async function legacyRecord(root:string,legacyRoot:string,manifest:ArticleManifest,directory:string,stage:string):Promise<CapturedContent>{
  const file=await containedFile(legacyRoot,path.relative(legacyRoot,path.join(directory,manifest.markdownFile??"article.md")));
  const input=parseContentLinks(manifest.sourceUrl)[0];const record:CapturedContent={platform:"wechat",nativeId:input?.nativeId??manifest.articleId,sourceUrl:manifest.sourceUrl,canonicalUrl:input?.canonicalUrl??manifest.sourceUrl,title:manifest.title,capturedAt:manifest.extractedAt,kind:"article",markdown:await fs.readFile(file,"utf8"),assets:[],warnings:[],coverage:{legacyArticleId:manifest.articleId}};
  for(const image of manifest.images??[]){const asset={id:`image-${image.index}`,role:"image" as const,status:image.status==="saved"?"saved" as const:"failed" as const,path:image.localPath,provenance:"original" as const};
    if(asset.path&&asset.status==="saved")try{await copyAsset(directory,asset.path,stage);}catch{asset.status="failed";}record.assets.push(asset);}
  for(const video of manifest.videos??[]){const asset={id:`video-${video.videoId??video.index}`,role:"video" as const,status:video.status==="saved"?"saved" as const:"unavailable" as const,path:video.localPath,reason:video.reason,provenance:"original" as const};
    if(asset.path&&asset.status==="saved")try{await copyAsset(directory,asset.path,stage);}catch{asset.status="unavailable";}record.assets.push(asset);}
  if(manifest.pdf?.status==="saved"){const relative=path.basename(manifest.pdf.path);try{await copyAsset(directory,relative,stage);record.assets.push({id:"legacy-pdf",role:"pdf",status:"saved",path:relative,provenance:"generated"});}catch{record.warnings.push("原文章PDF路径不可读取，可在新窗口重新生成");}}
  return record;
}
async function acquireWechat(input:ContentInput,context:ContentContext):Promise<CapturedContent>{
  const result=await runContentTool({command:process.execPath,args:[path.join(context.runtimeRoot,"dist","cli.js"),"capture",input.url],cwd:context.runtimeRoot,env:{...process.env,WECHAT_ARTICLE_READER_ROOT:context.runtimeRoot},signal:context.signal,timeoutMs:600000,maxOutputBytes:1048576});
  if(result.cancelled)throw new DOMException("已取消","AbortError");let parsed:{ok?:boolean;articleId?:string;message?:string}={};try{parsed=JSON.parse(result.stdout);}catch{}
  if(!parsed.articleId)throw new Error(publicValue(parsed.message||"微信读取失败，原窗口与已存资料仍可使用"));
  const legacyRoot=resolveLibraryRoot(context.runtimeRoot),article=await readArticle(legacyRoot,parsed.articleId);if(!article.ok)throw new Error(article.reason);
  const item=(await findArticles(legacyRoot,"")).find(value=>value.articleId===parsed.articleId);if(!item?.directory)throw new Error("找不到已保存微信资料");
  return legacyRecord("",legacyRoot,article.manifest,item.directory,context.directory);
}
export async function importLegacyArticles(runtimeRoot:string,root:string):Promise<void>{
  const legacyRoot=resolveLibraryRoot(runtimeRoot),known=await listManifests(root),knownIds=new Set(known.map(entry=>entry.manifest.contentId));let count=0;
  for(const item of await findArticles(legacyRoot,"")){
    if(known.some(entry=>entry.manifest.coverage?.legacyArticleId===item.articleId)||!item.directory)continue;
    const input=parseContentLinks(item.sourceUrl)[0];const identity=contentIdentity({platform:"wechat",nativeId:input?.nativeId??item.articleId,canonicalUrl:input?.canonicalUrl??item.sourceUrl});
    // findArticles is newest first; a stable item is imported once, never overwritten by an older version.
    if(knownIds.has(identity))continue;
    const article=await readArticle(legacyRoot,item.articleId);if(!article.ok)continue;
    const stage=path.join(root,"staging",`legacy-${item.articleId}`);await ensureDirectory(stage);
    try{const record=await legacyRecord(root,legacyRoot,article.manifest,item.directory,stage);await saveContent(root,record,stage);knownIds.add(identity);count++;}catch{/* Invalid legacy records remain untouched in the original library. */}
    if(count>=200)break;
  }
}
export async function listSavedContent(runtimeRoot:string,root:string,query="") {await importLegacyArticles(runtimeRoot,root);return findContent(root,query);}
export async function processContentJob(runtimeRoot:string,root:string,job:ContentJob,signal:AbortSignal,deps:ServiceDeps={}):Promise<Partial<ContentJob>>{
  const input=await (deps.resolve??resolveContentInput)(job.input,signal);await updateJob(root,job.id,{input,platform:input.platform});
  const stage=path.join(root,"staging",job.id);await ensureDirectory(stage);
  const previous=(await listManifests(root)).find(entry=>entry.manifest.contentId===contentIdentity(input)||entry.manifest.aliases.includes(job.input.url));
  let existing:CapturedContent|undefined;
  if(previous){existing={...previous.manifest,assets:previous.manifest.assets.map(a=>({...a}))};
    if(previous.manifest.bodyFile)existing.markdown=await fs.readFile(await containedFile(previous.directory,previous.manifest.bodyFile),"utf8");
    for(const asset of existing.assets)if(asset.path&&asset.status==="saved")try{const file=await containedFile(previous.directory,asset.path);if(asset.sha256&&await fileHash(file)!==asset.sha256)throw new Error("校验失败");await copyAsset(previous.directory,asset.path,stage);}catch{asset.status="failed";asset.reason="已存文件缺失或校验失败";}
  }
  let latest=previous?.manifest;let pendingProgress=Promise.resolve();let lastProgress=0;
  const context:ContentContext={runtimeRoot,directory:stage,signal,existing,onProgress:message=>{
    if(Date.now()-lastProgress<250)return;lastProgress=Date.now();pendingProgress=pendingProgress.then(()=>updateJob(root,job.id,{stage:publicValue(message),message:publicValue(message)})).catch(()=>{});
  },onCheckpoint:async record=>{
    latest=await saveContent(root,{...record,sourceUrl:job.input.url},stage);await updateJob(root,job.id,{title:record.title,contentId:latest.contentId});
  }};
  try {
  let record=await (deps.acquire??(input.platform==="wechat"?acquireWechat:acquireContent))(input,context);await context.onCheckpoint!(record);
  if(record.assets.some(a=>a.status==="login_required"))return {state:"login_required",contentId:latest!.contentId,title:record.title,message:"需要在专用浏览器登录或验证，完成后重试此任务"};
  if(signal.aborted)throw new DOMException("已取消","AbortError");
  await updateJob(root,job.id,{stage:"生成阅读资料",message:"正在提取字幕、转写与识别图片"});
  record=await (deps.enrich??enrichContent)(record,context);await context.onCheckpoint!(record);
  if(signal.aborted)throw new DOMException("已取消","AbortError");
  try{const pdf=await (deps.pdf??generateContentPdf)(contentDirectory(root,latest!.contentId),signal);if(pdf){await copyAsset(contentDirectory(root,latest!.contentId),pdf,stage);record.assets=record.assets.filter(a=>a.id!=="reading-pdf");record.assets.push({id:"reading-pdf",role:"pdf",status:"saved",path:pdf,provenance:"generated"});}}
  catch(error){record.assets.push({id:"reading-pdf",role:"pdf",status:"failed",reason:publicValue(error instanceof Error?error.message:"PDF生成失败")});}
  latest=await saveContent(root,{...record,sourceUrl:job.input.url},stage,{replacePreviousFailures:true});await updateJob(root,job.id,{contentId:latest.contentId,title:record.title});await pendingProgress;
  const missing=latest.assets.filter(a=>a.status!=="saved").length;
  return {state:latest.status,contentId:latest.contentId,title:record.title,message:latest.status==="completed"?"资料已保存，可离线阅读":latest.status==="failed"?"本轮未取得可阅读的资料，请查看失败原因":missing?`已保存可取得的资料；${missing}项未就绪，请查看逐项结果`:"主体资料已保存，部分内容的覆盖范围尚未确认，请查看采集说明"};
  } catch(error) {
    if(latest){const reason=signal.aborted?"本轮处理已取消，尚未完成的资料可重试":publicValue(error instanceof Error?error.message:"处理未完成");
      await saveContent(root,{...latest,warnings:[...latest.warnings,reason],assets:[...latest.assets.filter(a=>a.id!=="pipeline-error"),{id:"pipeline-error",role:"source",status:"failed",reason}]},contentDirectory(root,latest.contentId)).catch(()=>{});
    }await pendingProgress;throw error;
  }
}
export async function runContentQueue(runtimeRoot=runtimeDirectory(),root=contentRoot(runtimeRoot),onReady?:()=>void){return runJobs(root,(job,signal)=>processContentJob(runtimeRoot,root,job,signal),onReady);}

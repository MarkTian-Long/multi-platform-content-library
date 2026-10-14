import type { ContentInput,ContentJob,ContentJobResult,ContentContext,CapturedContent } from "./content-types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { parseContentLinks,resolveContentInput } from "./content-input.js";
import { acquireContent } from "./content-acquisition.js";
import { enrichContent } from "./content-enrichment.js";
import { runContentTool } from "./content-tools.js";
import { contentDirectory,contentIdentity,containedFile,fileHash,findContent,listManifests,saveContent,publicValue,ensureDirectory,writableFile } from "./content-library.js";
import { getJobs,runJobs,updateJob,tryContentMaintenance } from "./content-jobs.js";
import { findArticles,readArticle,type ArticleManifest } from "./article-library.js";
import { resolveLibraryRoot } from "./config.js";
import { resolveEdgeExecutable } from "./url-policy.js";
import { rewriteLocalAssetLinks } from "./content-paths.js";
import { runtimeDirectory,contentRoot } from "./content-runtime.js";
import { localDiagnostic,localDiagnosticError } from "./content-local-diagnostics.js";
import { normalizedProgress,parseProcessingMode,requestedProcessingAsset } from "./content-processing.js";
export { runtimeDirectory,contentRoot } from "./content-runtime.js";
export interface ServiceDeps { resolve?:(input:ContentInput,signal?:AbortSignal)=>Promise<ContentInput>; acquire?:(input:ContentInput,context:ContentContext)=>Promise<CapturedContent>;enrich?:(record:CapturedContent,context:ContentContext)=>Promise<CapturedContent>;pdf?:(directory:string,signal?:AbortSignal)=>Promise<string|undefined>; }

export async function generateContentPdf(directory:string,signal?:AbortSignal):Promise<string|undefined>{
  if(signal?.aborted)throw new DOMException("已取消","AbortError");const browser=await chromium.launch({executablePath:resolveEdgeExecutable(),headless:true});
  const abort=()=>{void browser.close().catch(()=>{});};signal?.addEventListener("abort",abort,{once:true});
  const temporary=await writableFile(directory,"阅读.pending.pdf");
  try{const manifest=JSON.parse(await fs.readFile(await containedFile(directory,"content.json"),"utf8"));
    const page=await browser.newPage();await page.route(/^https?:\/\//,route=>route.abort());await page.goto(pathToFileURL(await containedFile(directory,manifest.readingFile||"reading.html")).toString(),{waitUntil:"load",timeout:20000});
    await page.evaluate(()=>{document.querySelectorAll("img").forEach(image=>{image.loading="eager";});});
    await page.pdf({path:temporary,format:"A4",printBackground:true,margin:{top:"16mm",bottom:"16mm",left:"16mm",right:"16mm"}});
    const handle=await fs.open(temporary,"r");const signature=Buffer.alloc(5);try{await handle.read(signature,0,5,0);}finally{await handle.close();}
    if(signature.toString()!=="%PDF-")throw new Error("PDF格式校验失败");await fs.rename(temporary,await writableFile(directory,"阅读.pdf"));return "阅读.pdf";
  }finally{signal?.removeEventListener("abort",abort);await browser.close().catch(()=>{});await fs.unlink(temporary).catch(()=>{});}
}
async function copyAsset(sourceDir:string,relative:string,stage:string,destination=relative,signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();
  const source=await containedFile(sourceDir,relative);const target=await writableFile(stage,destination);
  if(source!==target){
    let intact=false;
    try{const stat=await fs.stat(target);intact=stat.isFile()&&stat.size===(await fs.stat(source)).size&&await fileHash(target)===await fileHash(source);}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    signal?.throwIfAborted();
    if(!intact)await fs.copyFile(source,target);
  }
  signal?.throwIfAborted();
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
  await tryContentMaintenance(root,async()=>importLegacyArticlesLocked(runtimeRoot,root));
}
async function importLegacyArticlesLocked(runtimeRoot:string,root:string):Promise<void>{
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
export async function listSavedContent(runtimeRoot:string,root:string,query="") {
  await importLegacyArticles(runtimeRoot,root);
  const {decorateContentItems}=await import("./content-organization.js");
  if(!query)return decorateContentItems(root,await findContent(root));
  const bodyMatches=await findContent(root,query),all=await findContent(root),tagMatches=await decorateContentItems(root,all,{query});
  const ids=new Set([...bodyMatches,...tagMatches].map(item=>item.contentId));
  return decorateContentItems(root,all.filter(item=>ids.has(item.contentId)));
}
/** Derivative retries for a single verified note/video do not depend on fresh signed URLs. */
async function reusableOriginalContent(record:CapturedContent|undefined,input:ContentInput,directory:string):Promise<boolean>{
  if(!record||!["xiaohongshu","wechat_channels","youtube","douyin","weibo","local"].includes(input.platform)||!input.nativeId||contentIdentity(record)!==contentIdentity(input)||record.parts?.some(part=>part.status!=="saved"))return false;
  if(input.platform==="weibo"&&!record.coverage?.body?.startsWith("saved"))return false;
  const localArticle=input.platform==="local"&&record.kind==="article",localImage=input.platform==="local"&&record.kind==="gallery";
  if(localArticle?!record.markdown.trim():!localImage&&!["video","audio"].includes(record.kind))return false;
  const originals=record.assets.filter(asset=>asset.provenance==="original");
  const sourceRole=localArticle?"source":localImage?"image":record.kind==="audio"?"audio":"video";
  if(originals.filter(asset=>asset.role===sourceRole).length!==1||originals.some(asset=>asset.status!=="saved"||!asset.path||!asset.sha256||!asset.bytes))return false;
  if(input.platform==="local"&&originals.find(asset=>asset.role===sourceRole)?.sha256!==input.nativeId.split(":").at(-1))return false;
  try{for(const asset of originals){const file=await containedFile(directory,asset.path!);if((await fs.stat(file)).size!==asset.bytes||await fileHash(file)!==asset.sha256)return false;}return true;}catch{return false;}
}
export async function processContentJob(runtimeRoot:string,root:string,job:ContentJob,signal:AbortSignal,deps:ServiceDeps={}):Promise<ContentJobResult>{
  if(signal.aborted)throw new DOMException("已取消","AbortError");
  const local=job.input.platform==="local";
  if(local&&(!job.input.localPath||!/^[a-z0-9]+:[a-f0-9]{64}$/.test(job.input.nativeId??"")||job.input.canonicalUrl!==`local://sha256/${job.input.nativeId!.replace(":","/")}`))throw new Error("本地任务缺少已选文件及内容身份，请重新导入");
  const known=await listManifests(root),source=parseContentLinks(job.input.url)[0],canonical=parseContentLinks(job.input.canonicalUrl)[0];
  const saved=known.find(entry=>entry.manifest.contentId===contentIdentity(job.input));
  // Keep only an identity already recorded for this exact share/canonical note.
  const savedInput=local?job.input:!deps.resolve&&saved&&job.input.nativeId&&canonical?.nativeId===job.input.nativeId&&source?.platform===job.input.platform&&saved.manifest.platform===job.input.platform&&saved.manifest.nativeId===job.input.nativeId&&(source.nativeId===job.input.nativeId||saved.manifest.aliases.includes(job.input.url))?job.input:undefined;
  const canReuse=savedInput&&saved&&await reusableOriginalContent(saved.manifest,savedInput,saved.directory);
  const resolved=local?job.input:canReuse?savedInput!:await (deps.resolve??resolveContentInput)(job.input,signal);
  const resolvedInput=!deps.resolve&&!resolved.nativeId&&savedInput&&resolved.platform===savedInput.platform?savedInput:resolved;
  const input={...resolvedInput, processing:parseProcessingMode(job.input.processing)};
  await updateJob(root,job.id,{input,platform:input.platform});
  const stage=path.join(root,"staging",job.id);await ensureDirectory(stage);
  const previous=known.find(entry=>entry.manifest.contentId===contentIdentity(input)||entry.manifest.aliases.includes(job.input.url));
  let existing:CapturedContent|undefined;
  if(previous){existing={...previous.manifest,assets:previous.manifest.assets.map(a=>({...a}))};
    if(previous.manifest.bodyFile)existing.markdown=await fs.readFile(await containedFile(previous.directory,previous.manifest.bodyFile),"utf8");
    const restorePaths=new Map<string,string>();
    for(const asset of existing.assets){signal.throwIfAborted();if(asset.path&&asset.status==="saved")try{const file=await containedFile(previous.directory,asset.path);if(asset.sha256&&await fileHash(file)!==asset.sha256)throw new Error("校验失败");
      const capturePath=asset.capturePath??asset.path;await copyAsset(previous.directory,asset.path,stage,capturePath,signal);restorePaths.set(asset.path,capturePath);asset.path=capturePath;
    }catch{if(signal.aborted)throw new DOMException("已取消","AbortError");asset.status="failed";asset.reason="已存文件缺失或校验失败";}}
    existing.markdown=rewriteLocalAssetLinks(existing.markdown,restorePaths);
  }
  let latest=previous?.manifest;let pendingProgress=Promise.resolve();let lastProgress=0;let lastProgressMessage="";
  const context:ContentContext={runtimeRoot,directory:stage,signal,existing,processing:input.processing,onProgress:(message,progress)=>{
    if(Date.now()-lastProgress<250&&!progress&&message===lastProgressMessage)return;lastProgress=Date.now();lastProgressMessage=message;pendingProgress=pendingProgress.then(()=>updateJob(root,job.id,{stage:publicValue(message),message:publicValue(message),progress:normalizedProgress(progress??{phase:publicValue(message)})})).catch(()=>{});
  },onCheckpoint:async record=>{
    latest=await saveContent(root,{...record,processingMode:input.processing,sourceUrl:job.input.url},stage);await updateJob(root,job.id,{title:record.title,contentId:latest.contentId});
  }};
  try {
  let record:CapturedContent;
  let reusedOriginal=false;
  if(!deps.acquire&&await reusableOriginalContent(existing,input,stage)){
    reusedOriginal=true;
    context.onProgress?.("复用已核验的原始资料，补充本地资料");
    record={...existing!,assets:existing!.assets.map(asset=>({...asset})),warnings:[...existing!.warnings],coverage:{...existing!.coverage}};
    if(input.platform==="youtube"){record.coverage!.access="available";delete record.coverage!.retryAfter;}
  }else if(!deps.acquire&&local){
    const {importLocalFile}=await import("./content-local-import.js");
    const imported=await importLocalFile(input.localPath!,{...context,onCheckpoint:undefined,explicitPath:input.localPath!,maxTextBytes:4*1024*1024,maxMediaBytes:2*1024*1024*1024,...(input.localTextEncoding?{textEncoding:input.localTextEncoding}:{})});
    if(imported.nativeId!==input.nativeId||imported.canonicalUrl!==input.canonicalUrl)throw new Error("源文件字节或格式已变化，请重新导入当前版本；已有资料保留");
    record=imported;
  }else record=await (deps.acquire??(input.platform==="wechat"?acquireWechat:acquireContent))(input,context);
  await context.onCheckpoint!(record);
  if(input.platform==="youtube"&&record.coverage?.access==="rate_limited"&&!record.assets.some(a=>a.role==="video"&&a.status==="saved")){
    await pendingProgress;
    return {state:"partial",contentId:latest!.contentId,title:record.title,message:"HTTP 429，已保留本轮资料，等待冷却后恢复",youtubeRateLimit:{retryAfter:record.coverage.retryAfter}};
  }
  if(record.assets.some(a=>a.status==="login_required")){await pendingProgress;return {state:"login_required",contentId:latest!.contentId,title:record.title,message:"需要在专用浏览器登录或验证，完成后重试此任务"};}
  if(signal.aborted)throw new DOMException("已取消","AbortError");
  await updateJob(root,job.id,{stage:"生成阅读资料",message:record.assets.some(asset=>["video","audio","image"].includes(asset.role))?"正在按所选选项整理文字和媒体":"正在生成离线阅读资料",progress:{phase:"本地处理"}});
  record=await (deps.enrich??enrichContent)(record,context);await context.onCheckpoint!(record);
  if(signal.aborted)throw new DOMException("已取消","AbortError");
  await pendingProgress;
  if(input.processing!=="original")await updateJob(root,job.id,{stage:"生成 PDF",message:"正在生成本地阅读 PDF",progress:{phase:"阅读 PDF"}});
  try{const directory=await contentDirectory(root,latest!.contentId);const pdf=input.processing==="original"?undefined:await (deps.pdf??generateContentPdf)(directory,signal);if(pdf){await copyAsset(directory,pdf,stage);record.assets=record.assets.filter(a=>a.id!=="reading-pdf");record.assets.push({id:"reading-pdf",role:"pdf",status:"saved",path:pdf,provenance:"generated"});}}
  catch(error){record.assets.push({id:"reading-pdf",role:"pdf",status:"failed",reason:local?localDiagnostic(error,input.localPath):publicValue(error instanceof Error?error.message:"PDF生成失败")});}
  latest=await saveContent(root,{...record,processingMode:input.processing,sourceUrl:job.input.url},stage,{replacePreviousFailures:true});await updateJob(root,job.id,{contentId:latest.contentId,title:record.title});await pendingProgress;
  const finalManifest=latest;
  const missing=finalManifest.assets.filter(a=>a.status!=="saved"&&requestedProcessingAsset(a,finalManifest.processingMode,finalManifest.kind)).length;
  return {state:latest.status,contentId:latest.contentId,title:record.title,...(!reusedOriginal&&input.platform==="youtube"&&record.assets.some(a=>a.role==="video"&&a.status==="saved")?{youtubeAccessRestored:true}:{}),message:latest.status==="completed"?"资料已保存，可离线阅读":latest.status==="failed"?"本轮未取得可阅读的资料，请查看失败原因":missing?`已保存可取得的资料；${missing}项未就绪，请查看逐项结果`:"主体资料已保存，部分内容的覆盖范围尚未确认，请查看采集说明"};
  } catch(error) {
    const safeError=local?localDiagnosticError(error,input.localPath):error;
    if(latest){const reason=signal.aborted?"本轮处理已取消，尚未完成的资料可重试":publicValue(safeError instanceof Error?safeError.message:"处理未完成");
      await saveContent(root,{...latest,warnings:[...latest.warnings,reason],assets:[...latest.assets.filter(a=>a.id!=="pipeline-error"),{id:"pipeline-error",role:"source",status:"failed",reason}]},await contentDirectory(root,latest.contentId)).catch(()=>{});
    }await pendingProgress;throw safeError;
  }
}
export async function runContentQueue(runtimeRoot=runtimeDirectory(),root=contentRoot(runtimeRoot),onReady?:()=>void,options:{scheduledOnly?:boolean}={}){
  const jobs=await runJobs(root,(job,signal)=>processContentJob(runtimeRoot,root,job,signal),onReady,options);
  // runJobs has released the worker mutex; the reclaimer acquires it and rechecks every file.
  // Failed/interrupted/unknown files stay available for recovery.
  try{
    const {inspectContentStorage,reclaimContentStaging}=await import("./content-storage.js");
    const plan=await inspectContentStorage(root),jobIds=plan.entries.filter(entry=>entry.reclaimableBytes>0).map(entry=>entry.jobId);
    if(jobIds.length)await reclaimContentStaging(root,{jobIds,expectedPlanId:plan.planId});
  }catch{/* Cleanup is optional; successful durable capture remains successful. */}
  return jobs;
}

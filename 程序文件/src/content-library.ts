import { selectReadingPdf } from "./content-reading.js";
import { renderReadingPage } from "./content-render.js";
import { renderWechatReadingPage } from "./wechat-reading.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { CapturedContent, ContentAsset, ContentListItem, ContentManifest, ContentStatus } from "./content-types.js";
import { isPathWithin } from "./url-policy.js";
import { contentFolderName,documentFileName,planAssetNames,safeFilename } from "./content-naming.js";
import { rewriteLocalAssetLinks } from "./content-paths.js";
import { contentDisplayTitle } from "./content-display.js";
import { requestedProcessingAsset } from "./content-processing.js";

const ID = /^[a-f0-9]{24}$/;
const secret = /token|secret|signature|authorization|cookie|session|sessdata|vkey|auth_key|^(?:sign|sig|key|expires|deadline|wstime|txtime|xsec_source)$/i;
export function publicUrl(value:string):string {
  try { if(/^local:\/\/sha256\/[a-z0-9]+\/[a-f0-9]{64}$/.test(value))return value;const url=new URL(value);if(!["https:","http:"].includes(url.protocol))return "";url.username="";url.password="";
    for(const key of [...url.searchParams.keys()])if(secret.test(key))url.searchParams.delete(key);return url.toString();
  }catch{return value;}
}
function redactText(value:string):string{return value.replace(/https?:\/\/[^\s<>"'）\]]+/gi,publicUrl).replace(/((?:proxy-)?authorization\s*[:=]\s*["']?(?:bearer|basic)\s+)[^\s,;"'}]+/gi,"$1[已隐藏]").replace(/((?:xsec_token|access_token|auth_key|authorization|cookie|sessdata|token|signature|sign|sig|vkey)\s*[:=]\s*)[^\s,;"'}]+/gi,"$1[已隐藏]");}
/** Single egress filter for CLI, MCP, reading pages and export. */
export function publicValue<T>(value:T):T {
  if(typeof value==="string")return redactText(value) as T;
  if(Array.isArray(value))return value.map(item=>publicValue(item)) as T;
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).filter(([key])=>!(key==="sourceUrl"&&"role" in value)&&!(key==="localPath"&&"platform" in value&&value.platform==="local")).map(([key,item])=>[key,secret.test(key)?"[已隐藏]":publicValue(item)])) as T;return value;
}
export function contentIdentity(record:Pick<CapturedContent,"platform"|"nativeId"|"canonicalUrl">):string{return crypto.createHash("sha256").update(`${record.platform}:${record.nativeId||publicUrl(record.canonicalUrl)}`).digest("hex").slice(0,24);}
export async function contentDirectory(root:string,id:string):Promise<string>{
  if(!ID.test(id))throw new Error("资料标识无效");
  const legacy=path.join(root,"items",id);
  if((await loadManifest(legacy))?.contentId===id)return legacy;
  const entries=await fs.readdir(path.join(root,"items"),{withFileTypes:true}).catch(()=>[]);
  const hint=`[${id.slice(0,8)}]`;
  // Naming is only a search-order hint; the full contained manifest must still match.
  entries.sort((a,b)=>Number(b.name.includes(hint))-Number(a.name.includes(hint)));
  for(const entry of entries){
    if(!entry.isDirectory()||entry.isSymbolicLink()||entry.name===id)continue;
    const directory=path.join(root,"items",entry.name);if((await loadManifest(directory))?.contentId===id)return directory;
  }return legacy;
}
export async function ensureDirectory(directory:string):Promise<void>{
  const absolute=path.resolve(directory);let current=path.parse(absolute).root;
  for(const segment of path.relative(current,absolute).split(path.sep).filter(Boolean)){
    current=path.join(current,segment);const stat=await fs.lstat(current).catch(error=>{if(error.code==="ENOENT")return undefined;throw error;});
    if(stat?.isSymbolicLink()||(stat&&!stat.isDirectory()))throw new Error("目录不允许符号链接或非目录路径");
    if(!stat)await fs.mkdir(current).catch(error=>{if(error.code!=="EEXIST")throw error;});
  }
}
async function existingPlainDirectory(directory:string):Promise<boolean>{
  const absolute=path.resolve(directory);let current=path.parse(absolute).root;
  for(const segment of path.relative(current,absolute).split(path.sep).filter(Boolean)){
    current=path.join(current,segment);const stat=await fs.lstat(current).catch(error=>{if(error.code==="ENOENT")return undefined;throw error;});
    if(!stat)return false;
    if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error("资料库目录不允许符号链接或非目录路径");
  }return true;
}
async function readLayoutVersion(root:string):Promise<2|3|undefined>{
  const marker=path.join(root,".library-layout.json"),stat=await fs.lstat(marker).catch(error=>{if(error.code==="ENOENT")return undefined;throw error;});
  if(!stat)return undefined;
  if(stat.isSymbolicLink()||!stat.isFile()||stat.size>4096)throw new Error("资料库布局标记无效");
  const file=await containedFile(root,".library-layout.json");let value:unknown;
  try{value=JSON.parse(await fs.readFile(file,"utf8"));}catch{throw new Error("资料库布局标记无效");}
  const version=value&&typeof value==="object"&&!Array.isArray(value)?(value as {version?:unknown}).version:undefined;
  if(version!==2&&version!==3)throw new Error("资料库布局标记版本无效");return version;
}
/** Adopt only a fresh default root; existing unmarked/custom stores need an explicit migration. */
export async function initializeDefaultLibraryLayout(root:string):Promise<2|3|undefined>{
  const version=await readLayoutVersion(root);if(version)return version;
  const absolute=path.resolve(root);if(path.basename(absolute)!=="资料库")return undefined;
  const exists=await existingPlainDirectory(absolute),entries=exists?await fs.readdir(absolute,{withFileTypes:true}):[];
  const files=new Set(["queue.json","queue.lock","worker.lock"]),directories=new Set(["items","staging","exports",".organization"]);
  for(const entry of entries){
    if(!files.has(entry.name)&&!directories.has(entry.name))return undefined;
    if(entry.isSymbolicLink())throw new Error("资料库初始化目录不允许符号链接");
    if(files.has(entry.name)?!entry.isFile():!entry.isDirectory())return undefined;
  }
  if(entries.some(entry=>entry.name==="items")&&(await fs.readdir(path.join(absolute,"items"))).length)return undefined;
  const oldRoot=path.resolve(absolute,"..","文章库"),oldStat=await fs.lstat(oldRoot).catch(error=>{if(error.code==="ENOENT")return undefined;throw error;});
  if(oldStat&&(oldStat.isSymbolicLink()||!oldStat.isDirectory()||(await fs.readdir(oldRoot)).length))return undefined;
  const marker=await writableFile(absolute,".library-layout.json");
  // Exclusive creation preserves a layout initialized by another writer; existing markers are never replaced.
  try{await fs.writeFile(marker,JSON.stringify({version:3},null,2)+"\n",{encoding:"utf8",flag:"wx"});}
  catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
  return readLayoutVersion(absolute);
}
function relativePath(root:string,relative:string):string {
  if(!relative||path.isAbsolute(relative)||/^[A-Za-z]:|[\x00-\x1f]/.test(relative))throw new Error("资料路径无效");
  const file=path.resolve(root,relative);if(!isPathWithin(root,file)||file===path.resolve(root))throw new Error("资料路径超出目录");return file;
}
export async function containedFile(root:string,relative:string):Promise<string>{
  const rootStat=await fs.stat(root);if(!rootStat.isDirectory())throw new Error("资料目录无效");
  let ancestor=path.resolve(root);while(ancestor!==path.dirname(ancestor)){if((await fs.lstat(ancestor)).isSymbolicLink())throw new Error("资料目录不允许符号链接");ancestor=path.dirname(ancestor);}
  const file=relativePath(root,relative),realRoot=await fs.realpath(root),realFile=await fs.realpath(file);
  if(!isPathWithin(realRoot,realFile)||(await fs.lstat(file)).isSymbolicLink()||!(await fs.stat(realFile)).isFile())throw new Error("资料路径超出目录或不是普通文件");return realFile;
}
export async function writableFile(root:string,relative:string):Promise<string>{
  const file=relativePath(root,relative);await ensureDirectory(root);let current=root;
  for(const segment of path.relative(root,path.dirname(file)).split(path.sep).filter(Boolean)){current=path.join(current,segment);await ensureDirectory(current);}
  if(!isPathWithin(await fs.realpath(root),await fs.realpath(path.dirname(file))))throw new Error("资料路径超出目录");
  if(await fs.lstat(file).then(s=>s.isSymbolicLink(),()=>false))throw new Error("资料路径不允许符号链接");return file;
}
export async function atomicJson(file:string,value:unknown):Promise<void>{
  await ensureDirectory(path.dirname(file));const temp=`${file}.${crypto.randomUUID()}.tmp`;
  try{await fs.writeFile(temp,JSON.stringify(value,null,2)+"\n","utf8");await atomicReplace(temp,file);}finally{await fs.unlink(temp).catch(()=>{});}
}
/** Windows readers/AV may briefly hold a destination handle; never delete the previous good file. */
export async function atomicReplace(source:string,destination:string):Promise<void>{
  const deadline=Date.now()+2500;let attempt=0;
  for(;;){try{await fs.rename(source,destination);return;}catch(error){
    if(!["EPERM","EACCES","EBUSY"].includes((error as NodeJS.ErrnoException).code??"")||Date.now()>=deadline)throw error;
    await new Promise(resolve=>setTimeout(resolve,Math.min(200,10*2**Math.min(attempt++,5))));
  }}
}
const hashCache=new Map<string,{stamp:string;hash:string}>();
export async function fileHash(file:string):Promise<string>{const stat=await fs.stat(file);const stamp=`${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;const known=hashCache.get(file);if(known?.stamp===stamp)return known.hash;
  const hash=crypto.createHash("sha256");for await(const chunk of createReadStream(file))hash.update(chunk);const digest=hash.digest("hex");if(hashCache.size>10000)hashCache.clear();hashCache.set(file,{stamp,hash:digest});return digest;}
async function atomicText(file:string,text:string):Promise<void>{const temp=`${file}.${crypto.randomUUID()}.tmp`;try{await fs.writeFile(temp,text,"utf8");await atomicReplace(temp,file);}finally{await fs.unlink(temp).catch(()=>{});}}
async function verifiedAsset(directory:string,asset:ContentAsset):Promise<boolean>{
  if(asset.status!=="saved"||!asset.path)return false;try{const file=await containedFile(directory,asset.path),size=(await fs.stat(file)).size;
    return size>0&&(!asset.bytes||asset.bytes===size)&&(!asset.sha256||asset.sha256===await fileHash(file));}catch{return false;}
}
function derivedSourceChanged(asset:ContentAsset,previous:ContentManifest|undefined,assets:ContentAsset[]):boolean{
  if(asset.derivation){const source=assets.find(a=>a.id===asset.derivation!.sourceId);return source?.integrityFailed===true||(source?.status==="saved"&&!!source.sha256&&source.sha256!==asset.derivation.sourceSha256);}
  if(!previous||!(["machine_asr","machine_ocr","sampled_frame"].includes(asset.provenance??"")||(asset.provenance==="generated"&&["audio","transcript"].includes(asset.role))))return false;
  let sources=previous.assets.filter(a=>a.status==="saved"&&a.sha256&&["video","audio","image","subtitle"].includes(a.role));
  const labelled=sources.filter(a=>asset.label===a.id||asset.label===`由 ${a.id} 提取的音轨`);if(labelled.length)sources=labelled;
  return sources.some(prior=>{const current=assets.find(a=>a.id===prior.id&&a.status==="saved");return !!current?.sha256&&current.sha256!==prior.sha256;});
}
export function contentStatus(record:CapturedContent):ContentStatus{
  if(!record.markdown.trim()&&!record.assets.some(a=>a.status==="saved"&&["video","audio","image","transcript"].includes(a.role)))return "failed";
  if(record.warnings.length||record.assets.some(a=>a.status!=="saved"&&requestedProcessingAsset(a,record.processingMode,record.kind)))return "partial";
  if(["douyin","weibo"].includes(record.platform)&&record.coverage?.body&&!record.coverage.body.startsWith("saved"))return "partial";
  if(record.kind==="video"){
    if(record.parts?.some(p=>p.status!=="saved"))return "partial";
    if(record.coverage&&Object.entries(record.coverage).some(([key,value])=>/part|media|comments|danmaku/.test(key)&&/unknown|not_attempted|failed|unavailable|mismatch/i.test(value)))return "partial";
    const required=record.processingMode==="original"?["video"]:record.processingMode==="transcribe"?["video","transcript"]:["video","audio","transcript","frame","ocr"];
    for(const id of record.parts?.length?record.parts.map(p=>p.id):[undefined])for(const role of required)
      if(!record.assets.some(a=>a.role===role&&a.status==="saved"&&(!id||a.partId===id)))return "partial";
  }
  if(record.kind==="gallery"){
    if(!record.assets.some(a=>a.role==="image"&&a.status==="saved")||record.parts?.some(part=>part.status!=="saved"))return "partial";
    if(Object.entries(record.coverage??{}).some(([key,value])=>["media","photos","livePhotos"].includes(key)&&/unknown|not_attempted|failed|unavailable|cancelled/i.test(value)))return "partial";
  }
  if(record.kind==="audio"&&!(record.processingMode==="original"?["audio"]:["audio","transcript"]).every(role=>record.assets.some(a=>a.role===role&&a.status==="saved")))return "partial";
  return "completed";
}
const localHref=(file:string)=>file.split(/[\\/]/).map(encodeURIComponent).join("/");
export function renderContentHtml(manifest:ContentManifest,markdown:string):string{
  return renderReadingPage(publicValue(manifest),publicValue(markdown));
}
async function renderSavedContentHtml(directory:string,manifest:ContentManifest,markdown:string,sourceManifest=manifest):Promise<string>{
  if(manifest.platform==="wechat"){
    const source=sourceManifest.assets.find(a=>a.id==="wechat-source-html"&&a.status==="saved"&&a.path&&!a.integrityFailed);
    if(source?.path){
      const file=await containedFile(directory,source.path);
      if((await fs.stat(file)).size>16*1024*1024)throw new Error("公众号原始页面超过16 MiB，未替换阅读页");
      const assets=manifest.assets.map(a=>({...a,sourceUrl:sourceManifest.assets.find(original=>original.id===a.id)?.sourceUrl}));
      const html=renderWechatReadingPage(await fs.readFile(file,"utf8"),{...manifest,assets},publicUrl);if(html)return html;
    }
  }
  return renderContentHtml(manifest,markdown);
}
async function loadManifest(directory:string):Promise<ContentManifest|undefined>{try{
  const file=await containedFile(directory,"content.json");if((await fs.stat(file)).size>8*1024*1024)return undefined;
  const item=JSON.parse(await fs.readFile(file,"utf8")) as ContentManifest;return item.schemaVersion===1&&ID.test(item.contentId)&&Array.isArray(item.assets)&&Array.isArray(item.warnings)?item:undefined;
}catch{return undefined;}}
export async function saveContent(root:string,record:CapturedContent,stage:string,options:{replacePreviousFailures?:boolean;checkpoint?:boolean}={}):Promise<ContentManifest>{
  if(Buffer.byteLength(record.markdown,"utf8")>4*1024*1024)throw new Error("正文超过4 MiB索引上限，原始文件仍保留在工作目录");
  const markerVersion=await initializeDefaultLibraryLayout(root);
  const contentId=contentIdentity(record);let directory=await contentDirectory(root,contentId);const previous=await loadManifest(directory);
  const version=record.storageVersion===3||previous?.storageVersion===3||markerVersion===3?3:record.storageVersion===2||previous?.storageVersion===2||markerVersion===2?2:undefined;
  const layout=version!==undefined;
  record={...record,...(version?{storageVersion:version}:{})};
  for(const asset of record.assets)if(asset.status==="saved"&&asset.path)await containedFile(stage,asset.path);
  if(!previous){
    await ensureDirectory(path.join(root,"items"));const name=contentFolderName(record,contentId);directory=path.join(root,"items",name);
    for(let suffix=2;await fs.lstat(directory).then(()=>true,()=>false);suffix++)directory=path.join(root,"items",`${name} (${suffix})`);
  }
  await ensureDirectory(directory);const merged:ContentAsset[]=[];const sources=new Map<string,string>();
  for(const incoming of record.assets){
    const prior=previous?.assets.find(a=>a.id===incoming.id);
    if(incoming.status!=="saved"&&!incoming.integrityFailed&&prior&&await verifiedAsset(directory,prior)){merged.push({...prior});sources.set(prior.id,await containedFile(directory,prior.path!));continue;}
    if(incoming.status==="saved"&&incoming.path){
      const source=await containedFile(stage,incoming.path),bytes=(await fs.stat(source)).size;
      if(bytes===0){merged.push({...incoming,status:"failed",reason:"文件为空，未标记保存成功"});continue;}
      sources.set(incoming.id,source);merged.push({...incoming,bytes,sha256:await fileHash(source)});
    }else merged.push({...incoming});
  }
  if(layout)for(const prior of previous?.assets??[]){
    const incoming=merged.find(a=>a.id===prior.id);
    if(prior.provenance!=="original"||prior.id.startsWith("original-history-")||!prior.path||!incoming?.sha256||incoming.sha256===prior.sha256||!await verifiedAsset(directory,prior))continue;
    const source=await containedFile(directory,prior.path),sha=await fileHash(source),relative=`历史版本/原件/${sha.slice(0,24)}${path.extname(prior.path)}`;
    const destination=await writableFile(directory,relative);
    if(source!==destination)await fs.copyFile(source,destination,fs.constants.COPYFILE_EXCL).catch(async error=>{if(error.code!=="EEXIST"||await fileHash(destination)!==sha)throw error;});
    const id=`original-history-${sha}`;
    if(!merged.some(a=>a.id===id)){merged.push({id,role:"source",status:"saved",path:relative,capturePath:relative,provenance:"original",sha256:sha,bytes:(await fs.stat(destination)).size,label:`历史原件 ${prior.label??prior.id}`});sources.set(id,destination);}
  }
  for(const prior of previous?.assets??[])if(!merged.some(a=>a.id===prior.id)&&!(options.replacePreviousFailures&&prior.status!=="saved")){
    if(prior.status==="saved"&&await verifiedAsset(directory,prior)){merged.push({...prior});sources.set(prior.id,await containedFile(directory,prior.path!));}
    else merged.push(prior.status!=="saved"?{...prior}:{...prior,status:"failed",reason:"已存文件缺失或完整性校验失败，请重试补充"});
  }
  for(let changed=true;changed;){changed=false;for(const asset of merged)if(asset.status==="saved"&&derivedSourceChanged(asset,previous,merged)){
    const failure=record.assets.find(a=>a.id===asset.id&&a.status!=="saved")?.reason;
    asset.status="failed";asset.integrityFailed=true;asset.reason=["原始素材已变化，旧派生结果不作为本次成功产物，请重试生成",failure].filter(Boolean).join("；");changed=true;
  }}
  if(layout)for(const asset of merged)if(asset.id==="legacy-pdf"){asset.role="source";asset.label="历史原文章 PDF";}
  const assets=planAssetNames({...record,assets:merged},previous?.namingVersion===1&&previous.storageVersion===record.storageVersion?previous.assets:undefined);
  const mapping=new Map<string,string>(),remoteMapping=new Map<string,string>();
  for(const asset of assets)if(asset.status==="saved"&&asset.path){
      const source=sources.get(asset.id);if(!source)throw new Error("找不到待保存的资料文件");
      const before=merged.find(a=>a.id===asset.id);if(before?.path)mapping.set(before.path,asset.path);
      if(asset.capturePath)mapping.set(asset.capturePath,asset.path);
      if(asset.sourceUrl)remoteMapping.set(asset.sourceUrl,asset.path);
      const dest=await writableFile(directory,asset.path),bytes=(await fs.stat(source)).size,sha256=await fileHash(source);
      if(source!==dest&&!(await fs.stat(dest).then(s=>s.size===bytes,()=>false)&&await fileHash(dest)===sha256)){
        const temp=`${dest}.${crypto.randomUUID()}.part`;try{await fs.copyFile(source,temp);await atomicReplace(temp,dest);}finally{await fs.unlink(temp).catch(()=>{});}
      }asset.bytes=bytes;asset.sha256=sha256;
  }
  const bodyLinks=(text:string,file:string,toRoot:boolean)=>rewriteLocalAssetLinks(text,new Map((previous?.assets??assets).filter(a=>a.path).map(a=>{const relative=path.posix.relative(path.posix.dirname(file),a.path!.replaceAll("\\","/"));return toRoot?[relative,a.path!]:[a.path!,relative];})));
  let body=record.markdown;
  if("schemaVersion" in record&&previous?.bodyFile)body=bodyLinks(await fs.readFile(await containedFile(directory,previous.bodyFile),"utf8"),previous.bodyFile,true);
  if(!body&&previous?.bodyFile)body=bodyLinks(await fs.readFile(await containedFile(directory,previous.bodyFile),"utf8"),previous.bodyFile,true);
  body=rewriteLocalAssetLinks(body,mapping);
  if(version===3)body=rewriteLocalAssetLinks(body,remoteMapping,{allowRemoteSources:true});
  let markdown=rewriteLocalAssetLinks(body,remoteMapping,{allowRemoteSources:true});const warnings=[...record.warnings];
  for(const a of assets)if(a.status==="saved"&&a.path&&["transcript","ocr"].includes(a.role)){
    try{const file=await containedFile(directory,a.path);if((await fs.stat(file)).size+Buffer.byteLength(markdown)<4*1024*1024)markdown+=`\n\n## ${a.label||a.role}（${a.provenance||"generated"}）\n\n${await fs.readFile(file,"utf8")}`;else warnings.push("派生文字超过索引上限，完整原文件已保留");}catch{}
  }
  markdown=redactText(markdown);const now=new Date().toISOString();
  const markdownFile=version===3?documentFileName(record,"md"):layout?"处理结果/资料正文.md":"资料正文.md";
  const bodyFile=version===3?(record.kind==="article"?markdownFile:".内部/原始正文.md"):layout?"原始资料/正文.md":"原始正文.md";
  const manifest:ContentManifest={...record,assets,markdown,warnings,contentId,schemaVersion:1,namingVersion:1,status:contentStatus({...record,assets,markdown,warnings}),aliases:[...new Set([...(previous?.aliases??[]),record.sourceUrl,record.canonicalUrl])],updatedAt:now,contentHash:crypto.createHash("sha256").update(markdown).digest("hex"),markdownFile,bodyFile,readingFile:version===3?documentFileName(record,"html"):"阅读.html"};
  if(Buffer.byteLength(JSON.stringify(manifest))>8*1024*1024)throw new Error("资料清单超过8 MiB上限，文件已保留");
  const retiredDocuments:string[]=[];
  const documentPathKey=(relative:string)=>{const resolved=path.resolve(directory,relative);return process.platform==="win32"?resolved.toLowerCase():resolved;};
  const currentDocumentPaths=()=>new Set([manifest.markdownFile,manifest.readingFile,...assets.map(a=>a.path)].filter((relative):relative is string=>!!relative).map(documentPathKey));
  if(version===3&&previous?.storageVersion===3){
    const currentPaths=currentDocumentPaths();
    for(const relative of new Set([previous.markdownFile,previous.readingFile,previous.assets.find(a=>a.id==="reading-pdf")?.path].filter(Boolean) as string[])){
      if(currentPaths.has(documentPathKey(relative)))continue;
      const source=await containedFile(directory,relative),sha=await fileHash(source),extension=path.extname(relative),stem=path.basename(relative,extension);
      const archived=`历史版本/阅读/${safeFilename(`${sha.slice(0,12)}_${stem}${extension}`,"历史阅读文件",80)}`,target=await writableFile(directory,archived);
      if(source!==target)await fs.copyFile(source,target,fs.constants.COPYFILE_EXCL).catch(async error=>{if(error.code!=="EEXIST"||await fileHash(target)!==sha)throw error;});
      const id=`document-history-${sha}`;if(!assets.some(a=>a.id===id))assets.push({id,role:"source",status:"saved",path:archived,capturePath:archived,provenance:"generated",bytes:(await fs.stat(target)).size,sha256:sha,label:`历史阅读文件 ${relative}`});retiredDocuments.push(relative);
    }
  }
  if(previous&&!options.checkpoint&&previous.contentHash!==manifest.contentHash)await atomicJson(await writableFile(directory,`${layout?"历史版本/清单":"versions"}/${previous.updatedAt.replace(/[:.]/g,"-")}.json`),publicValue(previous));
  const physical=(text:string,file:string)=>rewriteLocalAssetLinks(text,new Map(assets.filter(a=>a.path).map(a=>[a.path!,path.posix.relative(path.posix.dirname(file),a.path!.replaceAll("\\","/"))])));
  if(manifest.bodyFile!==manifest.markdownFile)await atomicText(await writableFile(directory,manifest.bodyFile!),physical(body,manifest.bodyFile!));
  await atomicText(await writableFile(directory,manifest.markdownFile),physical(version===3&&record.kind==="article"?body:markdown,manifest.markdownFile));await atomicText(await writableFile(directory,manifest.readingFile),await renderSavedContentHtml(directory,manifest,markdown));
  await atomicJson(await writableFile(directory,"content.json"),manifest);
  const publishedPaths=currentDocumentPaths();
  for(const relative of retiredDocuments)if(!publishedPaths.has(documentPathKey(relative)))await fs.unlink(await containedFile(directory,relative)).catch(error=>{if(!["EPERM","EACCES","EBUSY","ENOENT"].includes(error.code))throw error;});
  return manifest;
}
export async function listManifests(root:string):Promise<Array<{directory:string;manifest:ContentManifest}>>{
  const result:Array<{directory:string;manifest:ContentManifest}>=[];
  for(const entry of await fs.readdir(path.join(root,"items"),{withFileTypes:true}).catch(()=>[])){
    if(!entry.isDirectory()||entry.isSymbolicLink())continue;const directory=path.join(root,"items",entry.name),manifest=await loadManifest(directory);
    if(manifest)result.push({directory,manifest});
  }return result.sort((a,b)=>b.manifest.capturedAt.localeCompare(a.manifest.capturedAt));
}
export async function findContent(root:string,query=""):Promise<ContentListItem[]>{
  const needle=query.toLocaleLowerCase(),result:ContentListItem[]=[];
  for(const {directory,manifest:m} of await listManifests(root)){
    if(needle&&!`${m.title} ${m.author??""} ${m.canonicalUrl} ${m.markdown}`.toLocaleLowerCase().includes(needle))continue;
    const media=m.assets.find(a=>a.role==="video"&&a.status==="saved"),audio=m.assets.find(a=>a.role==="audio"&&a.status==="saved"),pdf=await (async()=>{const candidates=[...m.assets];for(;;){const candidate=selectReadingPdf(candidates);if(!candidate)return undefined;if(await verifiedAsset(directory,candidate))return candidate;candidates.splice(candidates.indexOf(candidate),1);}})(),original=m.platform==="local"?m.assets.find(a=>a.provenance==="original"&&a.status==="saved"):undefined;
    const readingPath=await containedFile(directory,m.readingFile).catch(()=>undefined);if(!readingPath)continue;
    const transcript=m.assets.filter(a=>["transcript","ocr"].includes(a.role)&&a.status==="saved"&&a.path).sort((a,b)=>Number(b.provenance==="user_edited")-Number(a.provenance==="user_edited")||Number(b.role==="transcript")-Number(a.role==="transcript"))[0];
    result.push({contentId:m.contentId,title:m.title,displayTitle:contentDisplayTitle(m.title),platform:m.platform,kind:m.kind,status:m.status,directory,readingPath,textPath:await containedFile(directory,m.markdownFile).catch(()=>undefined),pdfPath:pdf?.path?await containedFile(directory,pdf.path).catch(()=>undefined):undefined,videoPath:media?.path?await containedFile(directory,media.path).catch(()=>undefined):undefined,audioPath:audio?.path?await containedFile(directory,audio.path).catch(()=>undefined):undefined,originalPath:original?.path?await containedFile(directory,original.path).catch(()=>undefined):undefined,transcriptPath:transcript?.path?await containedFile(directory,transcript.path).catch(()=>undefined):undefined,sourceUrl:publicUrl(m.canonicalUrl),capturedAt:m.capturedAt});
  }return result;
}
export async function contentFile(root:string,id:string,relative:string):Promise<string>{return containedFile(await contentDirectory(root,id),relative);}
export async function readContent(root:string,id:string,offset=0,limit=16000):Promise<{ok:true;text:string;nextOffset:number|null;total:number;manifest:ContentManifest}|{ok:false;reason:string}>{
  if(!ID.test(id)||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>50000)return {ok:false,reason:"资料标识或读取范围无效"};
  const directory=await contentDirectory(root,id),manifest=await loadManifest(directory);if(!manifest)return {ok:false,reason:"资料不存在或清单损坏"};
  const file=await containedFile(directory,manifest.markdownFile).catch(()=>undefined);if(!file)return {ok:false,reason:"资料正文不存在"};
  const text=redactText(await fs.readFile(file,"utf8"));return {ok:true,text:text.slice(offset,offset+limit),nextOffset:offset+limit<text.length?offset+limit:null,total:text.length,manifest:publicValue({...manifest,markdown:""})};
}
export async function exportContent(root:string,id:string):Promise<{directory:string}>{
  const source=await contentDirectory(root,id),original=await loadManifest(source);if(!original)throw new Error("资料不存在");
  const manifest=publicValue(original),directory=path.join(root,"exports",`${contentFolderName(original,id)} - ${new Date().toISOString().replace(/[:.]/g,"-")}-${crypto.randomUUID().slice(0,4)}`);await ensureDirectory(directory);
  try{
  delete manifest.bodyFile;
  manifest.assets=manifest.assets.filter(a=>a.role!=="reading"&&(a.role!=="pdf"||manifest.storageVersion===3)&&(a.role!=="source"||(manifest.platform==="local"&&a.provenance==="original")));manifest.aliases=[publicUrl(manifest.canonicalUrl)];
  for(const a of manifest.assets)if(a.status==="saved"&&a.path){const from=await containedFile(source,a.path),to=await writableFile(directory,a.path);
    const bytes=(await fs.stat(from)).size,sha256=await fileHash(from);
    if(bytes<=0||a.bytes!==undefined&&a.bytes!==bytes||a.sha256!==undefined&&a.sha256!==sha256)throw new Error("原件在程序外变化或完整性校验失败，请核对后再导出");
    if(["subtitle","transcript","ocr","comments","danmaku"].includes(a.role)){await fs.writeFile(to,redactText(await fs.readFile(from,"utf8")),"utf8");a.bytes=(await fs.stat(to)).size;a.sha256=await fileHash(to);}else{await fs.copyFile(from,to);if((await fs.stat(to)).size!==bytes||await fileHash(to)!==sha256)throw new Error("导出期间原件变化，未发布资料包");a.bytes=bytes;a.sha256=sha256;}
    if(await fileHash(from)!==sha256)throw new Error("导出期间原件变化，未发布资料包");delete a.sourceUrl;
  }
  manifest.markdownFile=manifest.storageVersion===3?original.markdownFile:"资料正文.md";manifest.readingFile=manifest.storageVersion===3?original.readingFile:"阅读.html";
  const exportText=manifest.storageVersion===3?await fs.readFile(await containedFile(source,original.markdownFile),"utf8"):original.markdown;
  await fs.writeFile(path.join(directory,manifest.markdownFile),redactText(exportText),"utf8");await fs.writeFile(path.join(directory,manifest.readingFile),await renderSavedContentHtml(source,manifest,redactText(original.markdown),original),"utf8");await atomicJson(path.join(directory,"content.json"),manifest);return {directory};
  }catch(error){
    const destination=await fs.realpath(directory),exportsRoot=await fs.realpath(path.join(root,"exports"));
    if(path.dirname(destination)===exportsRoot&&!(await fs.lstat(directory)).isSymbolicLink())await fs.rm(destination,{recursive:true,force:true});
    throw error;
  }
}

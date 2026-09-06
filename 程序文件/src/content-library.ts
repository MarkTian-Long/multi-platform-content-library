import { renderReadingPage } from "./content-render.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { CapturedContent, ContentAsset, ContentListItem, ContentManifest, ContentStatus } from "./content-types.js";
import { isPathWithin } from "./url-policy.js";
import { contentFolderName,planAssetNames } from "./content-naming.js";
import { rewriteLocalAssetLinks } from "./content-paths.js";

const ID = /^[a-f0-9]{24}$/;
const secret = /token|secret|signature|authorization|cookie|session|sessdata|vkey|auth_key|^(?:sign|sig|key|expires|deadline|wstime|txtime|xsec_source)$/i;
export function publicUrl(value:string):string {
  try { const url=new URL(value);if(!["https:","http:"].includes(url.protocol))return "";url.username="";url.password="";
    for(const key of [...url.searchParams.keys()])if(secret.test(key))url.searchParams.delete(key);return url.toString();
  }catch{return value;}
}
function redactText(value:string):string{return value.replace(/https?:\/\/[^\s<>"'）\]]+/gi,publicUrl).replace(/((?:xsec_token|access_token|auth_key|authorization|cookie|sessdata|token|signature|sign|sig|vkey)\s*[:=]\s*)[^\s,;"'}]+/gi,"$1[已隐藏]");}
/** Single egress filter for CLI, MCP, reading pages and export. */
export function publicValue<T>(value:T):T {
  if(typeof value==="string")return redactText(value) as T;
  if(Array.isArray(value))return value.map(item=>publicValue(item)) as T;
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).filter(([key])=>!(key==="sourceUrl"&&"role" in value)).map(([key,item])=>[key,secret.test(key)?"[已隐藏]":publicValue(item)])) as T;return value;
}
export function contentIdentity(record:Pick<CapturedContent,"platform"|"nativeId"|"canonicalUrl">):string{return crypto.createHash("sha256").update(`${record.platform}:${record.nativeId||publicUrl(record.canonicalUrl)}`).digest("hex").slice(0,24);}
export async function contentDirectory(root:string,id:string):Promise<string>{
  if(!ID.test(id))throw new Error("资料标识无效");
  const legacy=path.join(root,"items",id);
  if((await loadManifest(legacy))?.contentId===id)return legacy;
  for(const entry of await fs.readdir(path.join(root,"items"),{withFileTypes:true}).catch(()=>[])){
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
export function contentStatus(record:CapturedContent):ContentStatus{
  if(!record.markdown.trim()&&!record.assets.some(a=>a.status==="saved"&&["video","image","transcript"].includes(a.role)))return "failed";
  if(record.warnings.length||record.assets.some(a=>a.status!=="saved"))return "partial";
  if(record.kind==="video"){
    if(record.parts?.some(p=>p.status!=="saved"))return "partial";
    if(record.coverage&&Object.entries(record.coverage).some(([key,value])=>/part|media|comments|danmaku/.test(key)&&/unknown|not_attempted|failed|unavailable|mismatch/i.test(value)))return "partial";
    for(const id of record.parts?.length?record.parts.map(p=>p.id):[undefined])for(const role of ["video","audio","transcript","frame","ocr"])
      if(!record.assets.some(a=>a.role===role&&a.status==="saved"&&(!id||a.partId===id)))return "partial";
  }
  if(record.kind==="gallery"&&!record.assets.some(a=>a.role==="image"&&a.status==="saved"))return "partial";
  return "completed";
}
const localHref=(file:string)=>file.split(/[\\/]/).map(encodeURIComponent).join("/");
export function renderContentHtml(manifest:ContentManifest,markdown:string):string{
  return renderReadingPage(publicValue(manifest),publicValue(markdown));
}
async function loadManifest(directory:string):Promise<ContentManifest|undefined>{try{
  const file=await containedFile(directory,"content.json");if((await fs.stat(file)).size>8*1024*1024)return undefined;
  const item=JSON.parse(await fs.readFile(file,"utf8")) as ContentManifest;return item.schemaVersion===1&&ID.test(item.contentId)&&Array.isArray(item.assets)&&Array.isArray(item.warnings)?item:undefined;
}catch{return undefined;}}
export async function saveContent(root:string,record:CapturedContent,stage:string,options:{replacePreviousFailures?:boolean}={}):Promise<ContentManifest>{
  if(Buffer.byteLength(record.markdown,"utf8")>4*1024*1024)throw new Error("正文超过4 MiB索引上限，原始文件仍保留在工作目录");
  const contentId=contentIdentity(record);let directory=await contentDirectory(root,contentId);const previous=await loadManifest(directory);
  for(const asset of record.assets)if(asset.status==="saved"&&asset.path)await containedFile(stage,asset.path);
  if(!previous){
    await ensureDirectory(path.join(root,"items"));const name=contentFolderName(record,contentId);directory=path.join(root,"items",name);
    for(let suffix=2;await fs.lstat(directory).then(()=>true,()=>false);suffix++)directory=path.join(root,"items",`${name} (${suffix})`);
  }
  await ensureDirectory(directory);const merged:ContentAsset[]=[];const sources=new Map<string,string>();
  for(const incoming of record.assets){
    const prior=previous?.assets.find(a=>a.id===incoming.id);
    if(incoming.status!=="saved"&&prior&&await verifiedAsset(directory,prior)){merged.push({...prior});sources.set(prior.id,await containedFile(directory,prior.path!));continue;}
    if(incoming.status==="saved"&&incoming.path){
      const source=await containedFile(stage,incoming.path),bytes=(await fs.stat(source)).size;
      if(bytes===0){merged.push({...incoming,status:"failed",reason:"文件为空，未标记保存成功"});continue;}
      sources.set(incoming.id,source);merged.push({...incoming,bytes,sha256:await fileHash(source)});
    }else merged.push({...incoming});
  }
  for(const prior of previous?.assets??[])if(!merged.some(a=>a.id===prior.id)&&!(options.replacePreviousFailures&&prior.status!=="saved")){
    if(prior.status==="saved"&&await verifiedAsset(directory,prior)){merged.push({...prior});sources.set(prior.id,await containedFile(directory,prior.path!));}
    else merged.push(prior.status!=="saved"?{...prior}:{...prior,status:"failed",reason:"已存文件缺失或完整性校验失败，请重试补充"});
  }
  const assets=planAssetNames({...record,assets:merged},previous?.namingVersion===1?previous.assets:undefined);
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
  let body=record.markdown;
  if("schemaVersion" in record&&previous?.bodyFile)body=await fs.readFile(await containedFile(directory,previous.bodyFile),"utf8");
  if(!body&&previous?.bodyFile)body=await fs.readFile(await containedFile(directory,previous.bodyFile),"utf8");
  body=rewriteLocalAssetLinks(body,mapping);
  let markdown=rewriteLocalAssetLinks(body,remoteMapping,{allowRemoteSources:true});const warnings=[...record.warnings];
  for(const a of assets)if(a.status==="saved"&&a.path&&["transcript","ocr"].includes(a.role)){
    try{const file=await containedFile(directory,a.path);if((await fs.stat(file)).size+Buffer.byteLength(markdown)<4*1024*1024)markdown+=`\n\n## ${a.label||a.role}（${a.provenance||"generated"}）\n\n${await fs.readFile(file,"utf8")}`;else warnings.push("派生文字超过索引上限，完整原文件已保留");}catch{}
  }
  markdown=redactText(markdown);const now=new Date().toISOString();
  const manifest:ContentManifest={...record,assets,markdown,warnings,contentId,schemaVersion:1,namingVersion:1,status:contentStatus({...record,assets,markdown,warnings}),aliases:[...new Set([...(previous?.aliases??[]),record.sourceUrl,record.canonicalUrl])],updatedAt:now,contentHash:crypto.createHash("sha256").update(markdown).digest("hex"),markdownFile:"资料正文.md",bodyFile:"原始正文.md",readingFile:"阅读.html"};
  if(Buffer.byteLength(JSON.stringify(manifest))>8*1024*1024)throw new Error("资料清单超过8 MiB上限，文件已保留");
  if(previous&&previous.contentHash!==manifest.contentHash)await atomicJson(await writableFile(directory,`versions/${previous.updatedAt.replace(/[:.]/g,"-")}.json`),publicValue(previous));
  await atomicText(await writableFile(directory,manifest.bodyFile!),body);await atomicText(await writableFile(directory,manifest.markdownFile),markdown);await atomicText(await writableFile(directory,manifest.readingFile),renderContentHtml(manifest,markdown));
  await atomicJson(await writableFile(directory,"content.json"),manifest);return manifest;
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
    const media=m.assets.find(a=>a.role==="video"&&a.status==="saved"),pdf=m.assets.find(a=>a.role==="pdf"&&a.status==="saved");
    const readingPath=await containedFile(directory,m.readingFile).catch(()=>undefined);if(!readingPath)continue;
    result.push({contentId:m.contentId,title:m.title,platform:m.platform,kind:m.kind,status:m.status,directory,readingPath,pdfPath:pdf?.path?await containedFile(directory,pdf.path).catch(()=>undefined):undefined,videoPath:media?.path?await containedFile(directory,media.path).catch(()=>undefined):undefined,sourceUrl:publicUrl(m.canonicalUrl),capturedAt:m.capturedAt});
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
  delete manifest.bodyFile;
  manifest.assets=manifest.assets.filter(a=>!["source","reading","pdf"].includes(a.role));manifest.aliases=[publicUrl(manifest.canonicalUrl)];
  for(const a of manifest.assets)if(a.status==="saved"&&a.path){const from=await containedFile(source,a.path),to=await writableFile(directory,a.path);
    if(["subtitle","transcript","ocr","comments","danmaku"].includes(a.role)){await fs.writeFile(to,redactText(await fs.readFile(from,"utf8")),"utf8");a.bytes=(await fs.stat(to)).size;a.sha256=await fileHash(to);}else await fs.copyFile(from,to);delete a.sourceUrl;
  }
  manifest.markdownFile="资料正文.md";manifest.readingFile="阅读.html";
  await fs.writeFile(path.join(directory,manifest.markdownFile),redactText(original.markdown),"utf8");await fs.writeFile(path.join(directory,manifest.readingFile),renderContentHtml(manifest,redactText(original.markdown)),"utf8");await atomicJson(path.join(directory,"content.json"),manifest);return {directory};
}

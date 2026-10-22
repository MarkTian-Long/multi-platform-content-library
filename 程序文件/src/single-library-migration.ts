import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {atomicJson,containedFile,contentDirectory,ensureDirectory,fileHash,listManifests,saveContent,writableFile} from "./content-library.js";
import {storageInventory} from "./content-storage-upgrade.js";
import {withContentMaintenance} from "./content-jobs.js";
import {rewriteLocalAssetLinks} from "./content-paths.js";
import {articleMarkdownBody} from "./markdown.js";
import {isPathWithin} from "./url-policy.js";
import type {ContentManifest} from "./content-types.js";

interface Entry{contentId:string;oldDirectory:string;newDirectory:string;preparedDirectory:string;backupDirectory:string;oldSignature:string;newSignature:string;state:string;}
interface Journal{version:1;project:string;backup:string;preparedRoot:string;status:string;oldMarker:string|null;itemsBefore?:string[];entries:Entry[];legacySignature:string|null;legacyArchive:string;}
export interface SingleLibraryOptions{backupDirectory:string;pdf?:(directory:string)=>Promise<string|undefined>;progress?:(message:string)=>void;}
const digest=(value:unknown)=>crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const exists=(file:string)=>fs.lstat(file).then(()=>true,()=>false);
async function signature(directory:string){return digest(await storageInventory(directory));}
function inside(project:string,target:string){if(path.resolve(project)===path.resolve(target)||!isPathWithin(path.resolve(project),path.resolve(target)))throw new Error("整理路径超出当前项目");}
async function move(project:string,source:string,destination:string){
 inside(project,source);inside(project,destination);await ensureDirectory(path.dirname(destination));
 const realProject=await fs.realpath(project),from=await fs.realpath(source),parent=await fs.realpath(path.dirname(destination));
 if(!isPathWithin(realProject,from)||!isPathWithin(realProject,parent)||(await fs.lstat(source)).isSymbolicLink()||await exists(destination))throw new Error("整理目标不安全或已有文件，未覆盖");
 await fs.rename(source,destination);
}
async function backupReady(project:string,backup:string){
 inside(project,backup);const report=JSON.parse(await fs.readFile(await containedFile(backup,"备份核验.json"),"utf8"));
 if(report.complete!==true||report.data?.verified!==true||!report.data?.path)throw new Error("需要先完成完整资料备份与回读核验");
 const archive=await fs.realpath(report.data.path);if(!isPathWithin(backup,archive)||!(await fs.stat(archive)).isFile())throw new Error("完整资料备份位置无效");
 const inventory=JSON.parse(await fs.readFile(await containedFile(backup,"整理前完整资料-清单.json"),"utf8"));
 if(!Array.isArray(inventory)||inventory.length!==report.data.files)throw new Error("备份清单不完整");
 const currentPaths:string[]=[];for(const name of ["资料库","文章库"])if(await exists(path.join(project,name)))for(const file of await storageInventory(path.join(project,name)))if(!(name==="资料库"&&file.path==="worker.lock"))currentPaths.push(`${name}/${file.path}`);
 if(JSON.stringify(currentPaths.sort())!==JSON.stringify(inventory.map((item:any)=>item.path).sort()))throw new Error("完整备份后资料文件集合发生变化，需要补充备份");
 for(const item of inventory){if(!/^(?:资料库|文章库)\//.test(item.path))throw new Error("备份条目超出资料范围");const file=await containedFile(project,item.path);if((await fs.stat(file)).size!==item.bytes||await fileHash(file)!==item.sha256)throw new Error("备份后资料已变化，需要重新核对备份");}
}
async function legacyRecords(project:string){
 const root=path.join(project,"文章库"),result:Array<{directory:string;manifest:any}>=[];
 for(const entry of await fs.readdir(root,{withFileTypes:true}).catch(()=>[])){
  if(entry.isSymbolicLink())throw new Error("旧资料库含目录链接，未整理");if(!entry.isDirectory())continue;
  const directory=path.join(root,entry.name);try{const manifest=JSON.parse(await fs.readFile(await containedFile(directory,"manifest.json"),"utf8"));if(/^[a-f0-9]{24}$/.test(manifest.articleId))result.push({directory,manifest});}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
 }return result;
}
function rootBody(body:string,manifest:ContentManifest){
 const file=manifest.bodyFile??manifest.markdownFile;
 return rewriteLocalAssetLinks(body,new Map(manifest.assets.filter(a=>a.path).map(a=>[path.posix.relative(path.posix.dirname(file),a.path!.replaceAll("\\","/")),a.path!])));
}
async function writeArticleIndex(directory:string,oldDirectory:string,saved:ContentManifest,mapping:Map<string,string>,legacy:Array<{directory:string;manifest:any}>){
 if(saved.platform!=="wechat")return;
 let article:any;try{article=JSON.parse(await fs.readFile(await containedFile(oldDirectory,"manifest.json"),"utf8"));}catch{article=legacy.find(a=>a.manifest.sourceUrl===saved.sourceUrl||a.manifest.articleId===saved.coverage?.legacyArticleId)?.manifest;}
 if(!article)throw new Error("公众号条目缺少旧接口身份，未发布");
 const ids=legacy.filter(a=>a.manifest.sourceUrl===saved.sourceUrl||a.manifest.articleId===saved.coverage?.legacyArticleId).map(a=>a.manifest.articleId);
 const asset=(id:string)=>saved.assets.find(a=>a.id===id),pdf=saved.assets.find(a=>a.id==="reading-pdf"&&a.status==="saved");
 const index={...article,contentId:saved.contentId,articleIds:[...new Set([article.articleId,...(article.articleIds??[]),...ids])],markdownFile:saved.markdownFile,htmlFile:asset("wechat-source-html")?.path,
  images:article.images?.map((i:any)=>({...i,localPath:mapping.get(i.localPath)??asset(`image-${i.index}`)?.path??i.localPath})),
  videos:article.videos?.map((v:any)=>({...v,localPath:mapping.get(v.localPath)??asset(`video-${v.videoId??v.index}`)?.path??v.localPath})),...(pdf?.path?{pdf:{status:"saved",path:pdf.path}}:{})};
 await atomicJson(await writableFile(directory,"manifest.json"),index);
}

/** Prepare verified copies only; live directories are unchanged until publishSingleLibrary(). */
export async function prepareSingleLibrary(project:string,options:SingleLibraryOptions):Promise<{journal:string;items:number;skipped:boolean}>{
 project=await fs.realpath(project);const root=path.join(project,"资料库"),backup=await fs.realpath(options.backupDirectory),journalFile=path.join(backup,"单库整理日志.json");inside(project,backup);
 return withContentMaintenance(root,async()=>{
  const current=await listManifests(root);if(current.length&&current.every(i=>i.manifest.storageVersion===3)&&!await exists(path.join(project,"文章库")))return{journal:journalFile,items:0,skipped:true};
  if(await exists(journalFile))throw new Error("已有整理日志，先核对或回退，不能覆盖");await backupReady(project,backup);
  const preparedRoot=path.join(backup,"准备区","资料库");await ensureDirectory(preparedRoot);await atomicJson(path.join(preparedRoot,".library-layout.json"),{version:3});
  const oldMarker=await fs.readFile(path.join(root,".library-layout.json"),"utf8").catch(()=>null),legacy=await legacyRecords(project);
  const journal:Journal={version:1,project,backup,preparedRoot,status:"preparing",oldMarker,itemsBefore:(await fs.readdir(path.join(root,"items"))).sort(),entries:[],legacySignature:await exists(path.join(project,"文章库"))?await signature(path.join(project,"文章库")):null,legacyArchive:path.join(backup,"旧文章库")};
  await atomicJson(journalFile,journal);
  for(const {directory,manifest:old} of current){
   options.progress?.(`准备：${old.title}`);const oldInventory=await storageInventory(directory),oldSignature=digest(oldInventory);
   for(const asset of old.assets)if(asset.status==="saved"&&asset.path){const file=await containedFile(directory,asset.path);if(asset.bytes!==undefined&&(await fs.stat(file)).size!==asset.bytes||asset.sha256&&await fileHash(file)!==asset.sha256)throw new Error("原文件校验失败，未迁移");}
   const rawBody=old.bodyFile?await fs.readFile(await containedFile(directory,old.bodyFile),"utf8"):old.markdown;
   let articleMetadata:{title:string;sourceUrl:string;extractedAt:string}|undefined;
   if(old.platform==="wechat")try{articleMetadata=JSON.parse(await fs.readFile(await containedFile(directory,"manifest.json"),"utf8"));}catch{}
   const body=old.platform==="wechat"?articleMarkdownBody(rootBody(rawBody,old),articleMetadata??{title:old.title,sourceUrl:old.sourceUrl,extractedAt:old.capturedAt}):rootBody(rawBody,old);
   const {schemaVersion:_schema,contentId:_id,status:_status,aliases:_aliases,updatedAt:_updated,contentHash:_hash,markdownFile:_md,readingFile:_html,bodyFile:_body,namingVersion:_naming,...capture}=old;
   let saved=await saveContent(preparedRoot,{...capture,storageVersion:3,markdown:body},directory),preparedDirectory=await contentDirectory(preparedRoot,saved.contentId);
   const mapping=new Map(old.assets.filter(a=>a.path).map(a=>[a.path!,saved.assets.find(b=>b.id===a.id)?.path??a.path!]));
   const managed=new Set(["content.json","manifest.json",old.bodyFile,old.markdownFile,old.readingFile,...old.assets.filter(a=>a.status==="saved").map(a=>a.path)].filter(Boolean));
   for(const file of oldInventory)if(!managed.has(file.path)){
    const relative=/^(?:历史版本|校订历史)\//.test(file.path)?file.path:`.内部/保留文件/${file.path}`;
    const target=await writableFile(preparedDirectory,relative);if(!await exists(target))await fs.copyFile(await containedFile(directory,file.path),target,fs.constants.COPYFILE_EXCL);
    if(await fileHash(target)!==file.sha256)throw new Error("历史或未知文件未完整保留");
   }
   if(options.pdf&&saved.assets.some(a=>a.id==="reading-pdf"&&a.status==="saved")){
    const pdf=await options.pdf(preparedDirectory);if(!pdf)throw new Error("阅读PDF生成失败，未发布");
    const fresh=JSON.parse(await fs.readFile(await containedFile(preparedDirectory,"content.json"),"utf8"));
    saved=await saveContent(preparedRoot,{...fresh,assets:[...fresh.assets.filter((a:any)=>a.id!=="reading-pdf"),{id:"reading-pdf",role:"pdf",status:"saved",path:pdf,provenance:"generated"}]},preparedDirectory);
   }
   saved.aliases=[...old.aliases];await atomicJson(await writableFile(preparedDirectory,"content.json"),saved);
   await writeArticleIndex(preparedDirectory,directory,saved,mapping,legacy);
   for(const asset of old.assets)if(asset.status==="saved"&&asset.path&&asset.id!=="reading-pdf"){
    const next=saved.assets.find(a=>a.id===asset.id);if(!next?.path||await fileHash(await containedFile(preparedDirectory,next.path))!==await fileHash(await containedFile(directory,asset.path)))throw new Error("原件或处理稿迁移后不一致");
   }
   await containedFile(preparedDirectory,saved.markdownFile);await containedFile(preparedDirectory,saved.readingFile);
   journal.entries.push({contentId:saved.contentId,oldDirectory:directory,newDirectory:path.join(root,"items",path.basename(preparedDirectory)),preparedDirectory,backupDirectory:path.join(backup,"旧正式条目",path.basename(directory)),oldSignature,newSignature:await signature(preparedDirectory),state:"prepared"});await atomicJson(journalFile,journal);
  }
  const ids=new Set<string>();for(const entry of journal.entries){try{const article=JSON.parse(await fs.readFile(path.join(entry.preparedDirectory,"manifest.json"),"utf8"));for(const id of [article.articleId,...(article.articleIds??[])])ids.add(id);}catch{}}
  for(const article of legacy)if(!ids.has(article.manifest.articleId))throw new Error("有旧文章ID尚未合并，保留原库并停止发布");
  journal.status="prepared";await atomicJson(journalFile,journal);return{journal:journalFile,items:journal.entries.length,skipped:false};
 });
}

async function readJournal(project:string,file:string):Promise<Journal>{
 inside(project,file);const journal:Journal=JSON.parse(await fs.readFile(await containedFile(project,path.relative(project,file)),"utf8"));
 if(journal.version!==1||path.resolve(journal.project)!==project)throw new Error("整理日志与项目不匹配");
 const items=path.join(project,"资料库","items");
 for(const entry of journal.entries){
  for(const file of [entry.oldDirectory,entry.newDirectory,entry.preparedDirectory,entry.backupDirectory])inside(project,file);
  if(path.dirname(entry.oldDirectory)!==items||path.dirname(entry.newDirectory)!==items||path.dirname(entry.preparedDirectory)!==path.join(journal.preparedRoot,"items")||path.dirname(entry.backupDirectory)!==path.join(journal.backup,"旧正式条目")||!/^[a-f0-9]{24}$/.test(entry.contentId))throw new Error("整理日志的条目位置无效");
 }
 inside(project,journal.backup);inside(project,journal.legacyArchive);if(journal.legacyArchive!==path.join(journal.backup,"旧文章库"))throw new Error("旧库归档位置无效");return journal;
}
async function rollbackUnlocked(project:string,journal:Journal,journalFile:string){
 if(journal.status==="rolled_back")return;
 // Preflight the whole set before moving any current file.
 for(const entry of journal.entries){
  const backedUp=await exists(entry.backupDirectory);
  if(!backedUp&&(!await exists(entry.oldDirectory)||await signature(entry.oldDirectory)!==entry.oldSignature))throw new Error("回退原目录或恢复备份缺失、校验失败，未移动资料");
  if(!backedUp&&entry.oldDirectory!==entry.newDirectory&&await exists(entry.newDirectory))throw new Error("已恢复原目录旁仍有新条目，拒绝不完整回退");
  if(backedUp&&await exists(entry.newDirectory)&&await signature(entry.newDirectory)!==entry.newSignature)throw new Error("整理后资料已有新变化，拒绝覆盖回退");
  if(backedUp&&await signature(entry.backupDirectory)!==entry.oldSignature)throw new Error("回退原目录校验失败");
  if(backedUp&&entry.oldDirectory!==entry.newDirectory&&await exists(entry.oldDirectory))throw new Error("旧位置已有新文件，拒绝覆盖回退");
  if(backedUp&&await exists(entry.newDirectory)&&await exists(path.join(journal.backup,"已回退的新目录",path.basename(entry.newDirectory))))throw new Error("回退目标已有内容，拒绝覆盖");
 }
 const legacy=path.join(project,"文章库"),legacyArchived=await exists(journal.legacyArchive);
 if(legacyArchived&&(!journal.legacySignature||await signature(journal.legacyArchive)!==journal.legacySignature))throw new Error("旧库归档已变化，拒绝覆盖回退");
 if(legacyArchived&&await exists(legacy))throw new Error("旧文章库位置已有新文件，拒绝覆盖回退");
 if(!legacyArchived&&journal.legacySignature&&(!await exists(legacy)||await signature(legacy)!==journal.legacySignature))throw new Error("旧文章库或恢复归档缺失、校验失败，未移动资料");
 for(const entry of [...journal.entries].reverse()){
  if(await exists(entry.backupDirectory)){
   if(await exists(entry.newDirectory))await move(project,entry.newDirectory,path.join(journal.backup,"已回退的新目录",path.basename(entry.newDirectory)));
   if(await exists(entry.oldDirectory))throw new Error("旧位置已有新文件，拒绝覆盖");await move(project,entry.backupDirectory,entry.oldDirectory);
  }
 }
 if(await exists(journal.legacyArchive)){if(await exists(legacy))throw new Error("旧文章库位置已有新文件，拒绝覆盖");await move(project,journal.legacyArchive,legacy);}
 const marker=path.join(project,"资料库",".library-layout.json");if(journal.oldMarker===null)await fs.unlink(marker).catch(error=>{if(error.code!=="ENOENT")throw error;});else await fs.writeFile(marker,journal.oldMarker,"utf8");
 journal.status="rolled_back";await atomicJson(journalFile,journal);
}
export async function publishSingleLibrary(project:string,journalFile:string):Promise<void>{
 project=await fs.realpath(project);const root=path.join(project,"资料库");await withContentMaintenance(root,async()=>{
  const journal=await readJournal(project,journalFile);if(journal.status==="completed")return;if(journal.status!=="prepared")throw new Error("整理尚未准备完成");
  const expectedItems=(journal.itemsBefore??journal.entries.map(entry=>path.basename(entry.oldDirectory))).sort();
  if(JSON.stringify((await fs.readdir(path.join(root,"items"))).sort())!==JSON.stringify(expectedItems))throw new Error("准备后条目集合发生变化，未替换");
  if(await fs.readFile(path.join(root,".library-layout.json"),"utf8").catch(()=>null)!==journal.oldMarker)throw new Error("准备后资料库标记发生变化，未替换");
  for(const entry of journal.entries){if(await signature(entry.oldDirectory)!==entry.oldSignature||await signature(entry.preparedDirectory)!==entry.newSignature)throw new Error("准备后资料发生变化，未替换");if(entry.newDirectory!==entry.oldDirectory&&await exists(entry.newDirectory))throw new Error("新目录位置已有内容，未覆盖");}
  const legacy=path.join(project,"文章库");if(journal.legacySignature&&await signature(legacy)!==journal.legacySignature)throw new Error("准备后旧库发生变化，未替换");
  try{
   journal.status="publishing";await atomicJson(journalFile,journal);
   for(const entry of journal.entries){await move(project,entry.oldDirectory,entry.backupDirectory);entry.state="saved_old";await atomicJson(journalFile,journal);await move(project,entry.preparedDirectory,entry.newDirectory);entry.state="published";await atomicJson(journalFile,journal);}
   if(journal.legacySignature)await move(project,legacy,journal.legacyArchive);
   await atomicJson(path.join(root,".library-layout.json"),{version:3});journal.status="completed";await atomicJson(journalFile,journal);
  }catch(error){await rollbackUnlocked(project,journal,journalFile);throw error;}
 });
}
export async function rollbackSingleLibrary(project:string,journalFile:string):Promise<void>{
 project=await fs.realpath(project);await withContentMaintenance(path.join(project,"资料库"),async()=>rollbackUnlocked(project,await readJournal(project,journalFile),journalFile));
}

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { listManifests,saveContent,containedFile,writableFile,ensureDirectory,atomicJson,fileHash,renderContentHtml,contentDirectory } from "./content-library.js";
import { withContentMaintenance } from "./content-jobs.js";
import { selectReadingPdf } from "./content-reading.js";
import { rewriteLocalAssetLinks } from "./content-paths.js";
import { isPathWithin } from "./url-policy.js";
import type { ContentManifest,ContentAsset } from "./content-types.js";
import type { ArticleManifest } from "./article-library.js";
interface Fingerprint {path:string;bytes:number;sha256:string;}
interface Entry {name:string;oldSignature:string;newSignature:string;state:"prepared"|"saved_old"|"published";}
interface Journal {version:1;project:string;backup:string;stage:string;status:string;entries:Entry[];markers:Array<{path:string;previous:string|null}>;linked:Array<{relative:string;sha256:string}>;snapshotsRemoved:number;originalsVerified:number;}
export interface UpgradeOptions {backupDirectory:string;pdf?:(directory:string)=>Promise<string|undefined>;progress?:(message:string)=>void;}
function inside(root:string,target:string){if(!isPathWithin(path.resolve(root),path.resolve(target))||path.resolve(root)===path.resolve(target))throw new Error("整理目标超出项目目录");}
export async function storageInventory(root:string):Promise<Fingerprint[]>{
  const result:Fingerprint[]=[];
  async function visit(directory:string){for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isSymbolicLink())throw new Error("整理目录不允许符号链接");if(entry.isDirectory())await visit(file);else if(entry.isFile()){await containedFile(root,path.relative(root,file));result.push({path:path.relative(root,file).replaceAll("\\","/"),bytes:(await fs.stat(file)).size,sha256:await fileHash(file)});}else throw new Error("整理目录含非普通文件");}}
  await visit(root);return result.sort((a,b)=>a.path.localeCompare(b.path));
}
async function signature(root:string){return crypto.createHash("sha256").update(JSON.stringify(await storageInventory(root))).digest("hex");}
async function verifyAssets(directory:string,manifest:ContentManifest){for(const a of manifest.assets)if(a.status==="saved"&&a.path){const file=await containedFile(directory,a.path),bytes=(await fs.stat(file)).size,sha=await fileHash(file);if(!bytes||a.bytes!==undefined&&a.bytes!==bytes||a.sha256&&a.sha256!==sha)throw new Error(`原件或已保存文件完整性校验失败：${a.id}`);}}
function intermediate(snapshot:ContentManifest,current:ContentManifest,body:string){return snapshot.contentId===current.contentId&&snapshot.capturedAt===current.capturedAt&&snapshot.nativeId===current.nativeId&&snapshot.markdown.startsWith(body.trim())&&!snapshot.assets.some(a=>a.provenance==="user_edited")&&snapshot.assets.filter(a=>a.status==="saved").every(a=>a.sha256&&current.assets.some(b=>b.id===a.id&&b.sha256===a.sha256));}
async function writeMarkers(project:string,journal:Journal){
  for(const marker of journal.markers){const file=path.join(project,marker.path);await ensureDirectory(path.dirname(file));await atomicJson(file,marker.path.startsWith("文章库")?{version:1,contentRoot:"../资料库"}:{version:2});}
}
export async function upgradeStorage(project:string,options:UpgradeOptions):Promise<{items:number;journal:string;snapshotsRemoved:number;originalsVerified:number;linkedFiles:number}>{
  project=await fs.realpath(project);const root=path.join(project,"资料库"),legacy=path.join(project,"文章库");inside(project,options.backupDirectory);
  for(const source of [root,legacy])if(path.resolve(options.backupDirectory)===source||isPathWithin(source,path.resolve(options.backupDirectory)))throw new Error("备份目录不能位于被整理资料库内");
  await ensureDirectory(options.backupDirectory);
  const backup=await fs.realpath(options.backupDirectory),journalFile=path.join(backup,"迁移日志.json");
  return withContentMaintenance(root,async()=>{
    const entries=(await listManifests(root)).filter(e=>e.manifest.storageVersion!==2&&e.manifest.storageVersion!==3);
    if(!entries.length)return {items:0,journal:journalFile,snapshotsRemoved:0,originalsVerified:0,linkedFiles:0};
    if(await fs.stat(journalFile).then(()=>true,()=>false))throw new Error("已有整理日志，请先检查或回退，不能覆盖");
    const stage=path.join(backup,"准备区");await ensureDirectory(stage);const stagedRoot=path.join(stage,"资料库");await ensureDirectory(stagedRoot);await atomicJson(path.join(stagedRoot,".library-layout.json"),{version:2});
    const markers:Journal["markers"]=[];for(const relative of ["资料库/.library-layout.json","文章库/.unified-library.json"]){const file=path.join(project,relative);const previous=await fs.readFile(file,"utf8").catch(error=>{if(error.code==="ENOENT")return null;throw error;});markers.push({path:relative,previous});}
    const journal:Journal={version:1,project,backup,stage,status:"preparing",entries:[],markers,linked:[],snapshotsRemoved:0,originalsVerified:0};await atomicJson(journalFile,journal);
    const legacyEntries:Array<{directory:string;manifest:ArticleManifest;signature:string}>=[];
    for(const entry of await fs.readdir(legacy,{withFileTypes:true}).catch(()=>[])){if(!entry.isDirectory()||entry.isSymbolicLink())continue;const directory=path.join(legacy,entry.name);try{const manifest=JSON.parse(await fs.readFile(await containedFile(directory,"manifest.json"),"utf8"));if(/^[a-f0-9]{24}$/.test(manifest.articleId))legacyEntries.push({directory,manifest,signature:await signature(directory)});}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
    const sources=new Map<string,{directory:string;manifest:ContentManifest}>();
    for(const {directory,manifest:old} of entries){
      options.progress?.(`准备：${old.title}`);await verifyAssets(directory,old);const oldSignature=await signature(directory),name=path.basename(directory),input=path.join(stage,"输入",old.contentId);await ensureDirectory(path.dirname(input));await fs.cp(directory,input,{recursive:true,errorOnExist:true,force:false});
      const body=old.bodyFile?await fs.readFile(await containedFile(input,old.bodyFile),"utf8"):old.markdown,assets=old.assets.map(a=>({...a}));
      const article=legacyEntries.find(a=>a.manifest.articleId===old.coverage?.legacyArticleId);
      if(article){for(const [id,relative] of [["wechat-source-html",article.manifest.htmlFile??"source.html"],["wechat-source-markdown",article.manifest.markdownFile??"article.md"],["wechat-source-manifest","manifest.json"]]){const from=await containedFile(article.directory,relative),target=`.迁移输入/${id}${path.extname(relative)}`;await fs.copyFile(from,await writableFile(input,target));assets.push({id,role:"source",status:"saved",path:target,provenance:"original"});}}
      const managed=new Set(["content.json",old.markdownFile,old.bodyFile,old.readingFile,...old.assets.filter(a=>a.status==="saved").map(a=>a.path)].filter(Boolean));
      for(const file of await storageInventory(directory))if(!managed.has(file.path)&&!file.path.startsWith("versions/")&&!file.path.startsWith("校订历史/")){assets.push({id:`preserved-${crypto.createHash("sha256").update(file.path).digest("hex").slice(0,16)}`,role:"source",status:"saved",path:file.path,provenance:"original",label:`保留原件 ${file.path}`});}
      let saved=await saveContent(stagedRoot,{...old,markdown:body,assets,storageVersion:2},input),destination=await contentDirectory(stagedRoot,saved.contentId);
      const mapping=new Map(assets.filter(a=>a.path).map(a=>[a.path!,saved.assets.find(b=>b.id===a.id)?.path??a.path!]));
      const versions=(await fs.readdir(path.join(input,"versions")).catch(()=>[])).filter(n=>n.endsWith(".json")).sort();
      for(let index=0;index<versions.length;index++){const file=versions[index],raw=await fs.readFile(await containedFile(input,`versions/${file}`),"utf8");let snapshot:ContentManifest|undefined;try{snapshot=JSON.parse(raw);}catch{}
        if(index>0&&index<versions.length-1&&snapshot&&intermediate(snapshot,old,body)){journal.snapshotsRemoved++;continue;}
        const target=await writableFile(destination,`历史版本/清单/${file}`);
        if(snapshot){snapshot={...snapshot,storageVersion:2,markdownFile:saved.markdownFile,bodyFile:saved.bodyFile,readingFile:saved.readingFile,assets:snapshot.assets.map(a=>({...a,...(a.path?{path:mapping.get(a.path)??a.path}:{})})),markdown:rewriteLocalAssetLinks(snapshot.markdown,mapping)};snapshot.contentHash=crypto.createHash("sha256").update(snapshot.markdown).digest("hex");await atomicJson(target,snapshot);}else await fs.writeFile(target,raw,"utf8");
      }
      if(await fs.stat(path.join(input,"校订历史")).then(()=>true,()=>false))await fs.cp(path.join(input,"校订历史"),path.join(destination,"校订历史"),{recursive:true});
      await atomicJson(await writableFile(destination,"历史版本/清单/迁移前.json"),old);
      if(options.pdf&&selectReadingPdf(saved.assets)){
        const file=await options.pdf(destination);if(!file)throw new Error("当前阅读PDF生成失败，未发布整理结果");
        saved=await saveContent(stagedRoot,{...saved,assets:[...saved.assets.filter(a=>a.id!=="reading-pdf"),{id:"reading-pdf",role:"pdf",status:"saved",path:file,provenance:"generated"}]},destination);
      }
      if(article){const a=(id:string)=>saved.assets.find(asset=>asset.id===id),pdf=selectReadingPdf(saved.assets);const manifest:ArticleManifest={...article.manifest,contentId:saved.contentId,articleIds:[article.manifest.articleId],markdownFile:saved.markdownFile,htmlFile:a("wechat-source-html")?.path,images:article.manifest.images?.map(i=>({...i,localPath:a(`image-${i.index}`)?.path??i.localPath})),videos:article.manifest.videos?.map(v=>({...v,localPath:a(`video-${v.videoId??v.index}`)?.path??v.localPath})),...(pdf?.path?{pdf:{status:"saved",path:pdf.path}}:{})};await atomicJson(await writableFile(destination,"manifest.json"),manifest);}
      await verifyAssets(destination,saved);
      for(const asset of old.assets.filter(a=>a.status==="saved"&&a.provenance==="original"&&a.path)){const next=saved.assets.find(a=>a.id===asset.id);if(!next?.path||await fileHash(await containedFile(directory,asset.path!))!==await fileHash(await containedFile(destination,next.path)))throw new Error("原件迁移校验不一致");journal.originalsVerified++;}
      if(article)for(const id of ["wechat-source-html","wechat-source-markdown","wechat-source-manifest"]){const asset=saved.assets.find(a=>a.id===id);if(!asset?.path)throw new Error("原始采集记录缺失");journal.originalsVerified++;}
      sources.set(name,{directory:destination,manifest:saved});journal.entries.push({name,oldSignature,newSignature:await signature(destination),state:"prepared"});await atomicJson(journalFile,journal);
    }
    // Recheck both roots after preparation; cached old processes may still write the legacy tree.
    for(const entry of journal.entries)if(await signature(path.join(root,"items",entry.name))!==entry.oldSignature)throw new Error("整理期间原资料发生变化，未发布");
    for(const item of legacyEntries)if(await signature(item.directory)!==item.signature)throw new Error("整理期间旧文章库发生变化，未发布");
    journal.status="publishing";await atomicJson(journalFile,journal);
    try{
      for(const entry of journal.entries){const live=path.join(root,"items",entry.name),old=path.join(backup,"原目录",entry.name),prepared=sources.get(entry.name)!.directory;await ensureDirectory(path.dirname(old));await fs.rename(live,old);entry.state="saved_old";await atomicJson(journalFile,journal);await fs.rename(prepared,live);entry.state="published";await atomicJson(journalFile,journal);}
      await writeMarkers(project,journal);
      // Only formats whose old writers never modify existing bytes in place may share storage.
      for(const item of legacyEntries){const migrated=entries.find(e=>e.manifest.coverage?.legacyArticleId===item.manifest.articleId);if(!migrated)continue;const current=(await listManifests(root)).find(e=>e.manifest.contentId===migrated.manifest.contentId)!;
        const candidates=[...(item.manifest.pdf?.status==="saved"?[item.manifest.pdf.path]:[]),...(item.manifest.videos??[]).filter(v=>v.status==="saved"&&v.localPath).map(v=>v.localPath!)];
        for(const relative of candidates){if(!/\.(?:pdf|mp4|webm|mov|m4v)$/i.test(relative))continue;const file=await containedFile(item.directory,relative);if((await fs.stat(file)).nlink>1)continue;const sha=await fileHash(file),asset=current.manifest.assets.find(a=>a.status==="saved"&&a.sha256===sha&&a.path);if(!asset?.path)continue;const canonical=await containedFile(current.directory,asset.path),projectRelative=path.relative(project,file),old=path.join(backup,"兼容原文件",projectRelative);inside(project,file);await ensureDirectory(path.dirname(old));const temporary=`${file}.${crypto.randomUUID()}.link`;journal.linked.push({relative:projectRelative,sha256:sha});await atomicJson(journalFile,journal);await fs.link(canonical,temporary);await fs.rename(file,old);try{await fs.rename(temporary,file);}catch(error){await fs.rename(old,file);await fs.unlink(temporary).catch(()=>{});throw error;}await atomicJson(journalFile,journal);}
      }
      journal.status="completed";await atomicJson(journalFile,journal);
    }catch(error){journal.status="needs_rollback";await atomicJson(journalFile,journal);await rollbackUnlocked(project,journal,journalFile,false);throw error;}
    return {items:journal.entries.length,journal:journalFile,snapshotsRemoved:journal.snapshotsRemoved,originalsVerified:journal.originalsVerified,linkedFiles:journal.linked.length};
  });
}
async function rollbackUnlocked(project:string,journal:Journal,file:string,_verify:boolean){
  if(journal.status==="rolled_back")return;
  const root=path.join(project,"资料库"),exists=(p:string)=>fs.lstat(p).then(()=>true,()=>false),restore:Entry[]=[];
  // Infer interrupted rename state from the filesystem and verify all targets before restoring.
  for(const entry of journal.entries){
    const live=path.join(root,"items",entry.name),old=path.join(journal.backup,"原目录",entry.name);inside(project,live);inside(journal.backup,old);
    if(await exists(old)){
      if(await signature(old)!==entry.oldSignature)throw new Error("回退原目录完整性已变化，拒绝覆盖");
      if(await exists(live)&&await signature(live)!==entry.newSignature)throw new Error("迁移后目录已有变化或新增文件，拒绝覆盖");restore.push(entry);
    }else if(!await exists(live)||await signature(live)!==entry.oldSignature)throw new Error("原目录或回退材料已变化，拒绝覆盖");
  }
  for(const linked of journal.linked){
    const live=path.join(project,linked.relative),old=path.join(journal.backup,"兼容原文件",linked.relative);inside(project,live);inside(journal.backup,old);
    if(await exists(old)&&await fileHash(await containedFile(journal.backup,path.relative(journal.backup,old)))!==linked.sha256)throw new Error("兼容回退原件已变化，拒绝覆盖");
    if(await exists(live)){if(await fileHash(await containedFile(project,linked.relative))!==linked.sha256)throw new Error("兼容文件已变化，拒绝覆盖");}else if(!await exists(old))throw new Error("兼容文件与回退原件缺失");
  }
  for(const entry of restore.reverse()){
    const live=path.join(root,"items",entry.name),old=path.join(journal.backup,"原目录",entry.name),discarded=path.join(journal.backup,"回退后的新版",entry.name);inside(project,discarded);
    if(await exists(live)){await ensureDirectory(path.dirname(discarded));await fs.rename(live,discarded);}
    await fs.rename(old,live);entry.state="prepared";await atomicJson(file,journal);
  }
  for(const linked of [...journal.linked]){
    const live=path.join(project,linked.relative),old=path.join(journal.backup,"兼容原文件",linked.relative),discarded=path.join(journal.backup,"回退后的兼容文件",linked.relative);inside(project,discarded);
    if(await exists(old)){const hadLive=await exists(live);if(hadLive){await ensureDirectory(path.dirname(discarded));await fs.rename(live,discarded);}try{await fs.rename(old,live);}catch(error){if(hadLive)await fs.rename(discarded,live);throw error;}}
    journal.linked=journal.linked.filter(item=>item!==linked);await atomicJson(file,journal);
  }
  for(const marker of journal.markers){const target=path.join(project,marker.path);if(marker.previous===null)await fs.unlink(target).catch(error=>{if(error.code!=="ENOENT")throw error;});else await fs.writeFile(target,marker.previous,"utf8");}
  journal.status="rolled_back";await atomicJson(file,journal);
}
export async function rollbackStorageUpgrade(project:string,journalFile:string):Promise<void>{project=await fs.realpath(project);inside(project,journalFile);const journal=JSON.parse(await fs.readFile(await containedFile(project,path.relative(project,journalFile)),"utf8")) as Journal;if(journal.version!==1||journal.project!==project)throw new Error("回退日志与项目不一致");inside(project,journal.backup);
  const expected=["资料库/.library-layout.json","文章库/.unified-library.json"];
  if(!Array.isArray(journal.markers)||journal.markers.length!==2||new Set(journal.markers.map(m=>m.path)).size!==2||journal.markers.some(m=>!expected.includes(m.path)||(m.previous!==null&&typeof m.previous!=="string")))throw new Error("回退标记路径无效");
  if(!Array.isArray(journal.entries)||journal.entries.some(e=>!e.name||e.name==="."||e.name===".."||path.basename(e.name)!==e.name||/[\\/:]/.test(e.name)))throw new Error("回退条目路径无效");
  for(const source of [path.join(project,"资料库"),path.join(project,"文章库")])if(path.resolve(journal.backup)===source||isPathWithin(source,path.resolve(journal.backup)))throw new Error("回退备份范围无效");
  await withContentMaintenance(path.join(project,"资料库"),()=>rollbackUnlocked(project,journal,journalFile,true));}

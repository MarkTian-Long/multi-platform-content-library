import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { CapturedContent,ContentManifest } from "./content-types.js";
import { atomicJson,containedFile,contentDirectory,ensureDirectory,fileHash,listManifests,saveContent,writableFile } from "./content-library.js";
import { contentFolderName } from "./content-naming.js";
import { withContentMaintenance } from "./content-jobs.js";
import { generateContentPdf } from "./content-service.js";
import { isPathWithin } from "./url-policy.js";

interface MigrationItem {contentId:string;directory:string;backupDirectory?:string;}
export interface MigrationResult {migrated:number;skipped:number;items:MigrationItem[];failed:Array<{contentId:string;reason:string}>;}
interface MigrationOptions {pdf?:(directory:string)=>Promise<string|undefined>;}

async function recoverPublishedMigrations(root:string):Promise<MigrationItem[]>{
 const recovered:MigrationItem[]=[];const backups=path.join(root,".命名备份");
 for(const entry of await fs.readdir(backups,{withFileTypes:true}).catch(()=>[])){
   if(!entry.isDirectory()||entry.isSymbolicLink())continue;
   const backupRoot=path.join(backups,entry.name);let record:any;
   try{const file=await containedFile(backupRoot,"迁移记录.json");if((await fs.stat(file)).size>1024*1024)continue;record=JSON.parse(await fs.readFile(file,"utf8"));}catch{continue;}
   if(!["prepared","published"].includes(record.state)||!/^[a-f0-9]{24}$/.test(record.contentId))continue;
   const original=path.resolve(String(record.oldDirectory)),destination=path.resolve(String(record.directory));
   const backup=path.join(backupRoot,"原目录"),items=path.resolve(root,"items");
   if(path.dirname(original)!==items||path.dirname(destination)!==items||original===destination)throw new Error("未完成的整理记录路径无效，原资料已保留");
   const originalExists=await fs.lstat(original).then(()=>true,()=>false);
   let published:ContentManifest;try{published=JSON.parse(await fs.readFile(await containedFile(destination,"content.json"),"utf8"));}catch{continue;}
   if(published.contentId!==record.contentId||published.namingVersion!==1)throw new Error("未完成的整理记录与资料不匹配");
   if(record.state==="prepared"&&originalExists){
     // The process may have stopped before PDF regeneration. Keep the old item authoritative.
     await moveDirectory(root,destination,path.join(backupRoot,"未完成的新目录"));
     await atomicJson(path.join(backupRoot,"迁移记录.json"),{...record,state:"rolled_back"});continue;
   }
   if(record.state==="published"&&originalExists){
     const before:ContentManifest=JSON.parse(await fs.readFile(await containedFile(original,"content.json"),"utf8"));
     if(before.contentId!==record.contentId)throw new Error("未完成的整理记录与原资料不匹配");
     for(const asset of before.assets)if(asset.status==="saved"&&asset.path&&asset.role!=="pdf"){
       const after=published.assets.find(a=>a.id===asset.id&&a.status==="saved"&&a.path);
       if(!after?.path||await fileHash(await containedFile(original,asset.path))!==await fileHash(await containedFile(destination,after.path)))throw new Error("未完成的整理尚未通过文件校验，原资料已保留");
     }
     await moveDirectory(root,original,backup);
   }
   if(!originalExists&&!(await fs.stat(backup).then(stat=>stat.isDirectory(),()=>false)))throw new Error("未完成的整理记录缺少原目录备份");
   await atomicJson(path.join(backupRoot,"迁移记录.json"),{...record,state:"completed",backupDirectory:backup});
   recovered.push({contentId:record.contentId,directory:destination,backupDirectory:backup});
 }return recovered;
}

/** Both endpoints are checked before any directory move, including on Windows. */
async function moveDirectory(root:string,source:string,destination:string):Promise<void>{
 const base=path.resolve(root),from=path.resolve(source),to=path.resolve(destination);
 if(from===base||to===base||!isPathWithin(base,from)||!isPathWithin(base,to))throw new Error("整理路径超出资料库");
 await ensureDirectory(path.dirname(to));
 const realRoot=await fs.realpath(base),realSource=await fs.realpath(from),realParent=await fs.realpath(path.dirname(to));
 if(!isPathWithin(realRoot,realSource)||!isPathWithin(realRoot,realParent)||(await fs.lstat(from)).isSymbolicLink())throw new Error("整理路径不允许符号链接或越界");
 await fs.rename(from,to);
}

async function migrateItem(root:string,directory:string,manifest:ContentManifest,options:MigrationOptions):Promise<MigrationItem>{
 const stamp=new Date().toISOString().replace(/[:.]/g,"-")+"-"+crypto.randomUUID().slice(0,8);
 const temporaryRoot=path.join(root,".命名整理",stamp),backupRoot=path.join(root,".命名备份",stamp),backupDirectory=path.join(backupRoot,"原目录");
 await ensureDirectory(temporaryRoot);await ensureDirectory(backupRoot);
 const journal=path.join(backupRoot,"迁移记录.json");let destination="",published=false,committed=false;
 try{
   const originalHashes=new Map<string,string>();
   for(const asset of manifest.assets)if(asset.status==="saved"&&asset.path){
     const file=await containedFile(directory,asset.path),hash=await fileHash(file);
     if(asset.sha256&&asset.sha256!==hash)throw new Error("原文件校验值不符，已保留原资料，请先核对文件");
     originalHashes.set(asset.id,hash);
   }
   const {schemaVersion:_schema,contentId:_id,status:_status,aliases:_aliases,updatedAt:_updated,contentHash:_hash,markdownFile:_md,readingFile:_html,bodyFile:_body,namingVersion:_naming,...capture}=manifest;
   const body=manifest.bodyFile?await fs.readFile(await containedFile(directory,manifest.bodyFile),"utf8"):manifest.markdown;
   const record:CapturedContent={...capture,markdown:body,assets:manifest.assets.map(a=>({...a}))};
   const saved=await saveContent(temporaryRoot,record,directory);
   saved.aliases=[...manifest.aliases];
   const prepared=await contentDirectory(temporaryRoot,saved.contentId);
   await atomicJson(await writableFile(prepared,"content.json"),saved);
   const name=contentFolderName(saved,saved.contentId);await ensureDirectory(path.join(root,"items"));
   destination=path.join(root,"items",name);
   for(let suffix=2;await fs.lstat(destination).then(()=>true,()=>false);suffix++)destination=path.join(root,"items",`${name} (${suffix})`);
   const mapping=saved.assets.filter(a=>a.path).map(a=>({id:a.id,oldPath:manifest.assets.find(prior=>prior.id===a.id)?.path,newPath:a.path}));
   await atomicJson(journal,{contentId:saved.contentId,state:"prepared",oldDirectory:directory,directory:destination,backupDirectory,mapping});
   for(const asset of saved.assets)if(asset.status==="saved"&&asset.path&&originalHashes.has(asset.id)){
     if(await fileHash(await containedFile(prepared,asset.path))!==originalHashes.get(asset.id))throw new Error("整理后文件与原文件不一致，尚未替换原资料");
   }
   await moveDirectory(root,prepared,destination);published=true;
   const pdf=saved.assets.find(a=>a.role==="pdf"&&a.status==="saved");
   if(pdf){
     const generated=await (options.pdf??generateContentPdf)(destination);
     if(!generated)throw new Error("未能重新生成 PDF，原资料已保留");
     const file=await containedFile(destination,generated);pdf.path=generated;pdf.bytes=(await fs.stat(file)).size;pdf.sha256=await fileHash(file);
     await atomicJson(await writableFile(destination,"content.json"),saved);
   }
   await atomicJson(journal,{contentId:saved.contentId,state:"published",oldDirectory:directory,directory:destination,backupDirectory,mapping});
   await moveDirectory(root,directory,backupDirectory);committed=true;
   await atomicJson(journal,{contentId:saved.contentId,state:"completed",oldDirectory:directory,directory:destination,backupDirectory,mapping});
   return {contentId:saved.contentId,directory:destination,backupDirectory};
 }catch(error){
   if(committed)return {contentId:manifest.contentId,directory:destination,backupDirectory};
   if(published){await moveDirectory(root,destination,path.join(temporaryRoot,"未发布资料"));published=false;}
   await atomicJson(journal,{contentId:manifest.contentId,state:"failed",oldDirectory:directory,reason:error instanceof Error?error.message:String(error)}).catch(()=>{});
   throw error;
 }finally{
   // This is a new, uniquely created workspace subtree, never the library or an existing item.
   const temp=path.resolve(temporaryRoot),base=path.resolve(root);
   if(temp!==base&&isPathWithin(base,temp)&&!(await fs.lstat(temp)).isSymbolicLink())await fs.rm(temp,{recursive:true,force:true});
 }
}

export async function migrateReadableLibrary(root:string,options:MigrationOptions={}):Promise<MigrationResult>{
 return withContentMaintenance(root,async()=>{
   const result:MigrationResult={migrated:0,skipped:0,items:[],failed:[]};
   const recovered=await recoverPublishedMigrations(root);result.items.push(...recovered);result.migrated+=recovered.length;
   for(const {directory,manifest} of await listManifests(root)){
     if(manifest.namingVersion===1&&path.basename(directory)!==manifest.contentId){result.skipped++;continue;}
     try{const item=await migrateItem(root,directory,manifest,options);result.items.push(item);result.migrated++;}
     catch(error){result.failed.push({contentId:manifest.contentId,reason:error instanceof Error?error.message:String(error)});}
   }return result;
 });
}

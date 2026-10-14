import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {atomicJson,containedFile,writableFile,publicValue} from './content-library.js';
import {archiveRelativePath,archiveTree,archiveFileHash,writeVerifiedZip,verifyContentZip,extractContentZip,withOrganizationLock,type VerifiedZip} from './content-organization.js';

export interface ContentLogArchiveOptions {directories:string[];closedDirectories:string[];activeDirectories?:string[];rebuildableDirectories?:string[];signal?:AbortSignal;}
export interface ContentLogArchiveEntry {directory:string;eligible:boolean;reason?:string;files:Array<{path:string;bytes:number;sha256:string}>;bytes:number;rebuildable:boolean;}
export interface ContentLogArchivePlan {version:1;planId:string;generatedAt:string;entries:ContentLogArchiveEntry[];totalBytes:number;}
export interface ContentLogArchiveItem {archiveId:string;createdAt:string;directories:string[];removedDirectories:string[];zipPath:string;bytes:number;sha256:string;}
interface LogRecord {version:1;archiveId:string;planId:string;createdAt:string;directories:string[];removedDirectories:string[];zip:Omit<VerifiedZip,'path'> & {path:string};}
const MAX=2*1024*1024*1024;
function logDirectory(value:string):string{const key=archiveRelativePath(value);if(!/^logs\/[^/]+$/.test(key)||key.split('/')[1].startsWith('.'))throw new Error('只接受logs中的历史顶层目录');return key;}
function protectedPath(value:string):boolean{
  return value.split('/').some(part=>/^(?:src|source|sources|tools|node_modules|\.git|\.content-profile|\.wechat-reader-profile|\.drafts?|drafts?|编辑草稿|校订草稿|草稿|profiles?|browser|browsers?|history|staging|recovery|restore|backups?|credentials?|private|原始资料|恢复|源码|工具|浏览器)(?:$|[._-])/i.test(part)
    ||/(?:^|[._-])(?:active|running|pending|lock|tmp|partial|cookies?|secret|restore|backup)(?:[._-]|$)/i.test(part))
    ||/\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|ps1|cmd|bat|exe|dll|pem|key)$/i.test(value);
}
const diagnosticFile=(name:string)=>/\.(?:json|log|txt|md|csv|tsv|png|jpe?g|webp|gif|bmp|mp4|webm|m4a|mp3|wav|srt|vtt)$/i.test(name);
async function checkDirectoryPolicy(root:string,signal?:AbortSignal):Promise<void>{
  let directories=0;
  async function visit(relative:string){signal?.throwIfAborted();for(const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})){if(entry.isSymbolicLink())throw new Error('日志拒绝链接');if(entry.isDirectory()){const next=relative?`${relative}/${entry.name}`:entry.name;if(protectedPath(next))throw new Error('日志包含活动、恢复、草稿或浏览器目录');if(++directories>4096)throw new Error('日志目录数量超过上限');await visit(next);}}}
  await visit('');
}
async function privateEvidence(root:string,relative:string):Promise<boolean>{
  if(!/\.(?:json|log|txt|md|csv|tsv|srt|vtt)$/i.test(relative))return false;const file=await containedFile(root,relative);let carry='';
  for await(const chunk of createReadStream(file,{encoding:'utf8',highWaterMark:65536})){const text=carry+chunk;if(/"(?:localPath|cookies?|authorization|rawBody|rawHtml|bodySnapshot)"\s*:/i.test(text)||publicValue(text)!==text)return true;carry=text.slice(-2048);}return false;
}
/** Planning never marks a directory closed: the coordinator must supply the confirmed stop-write list. */
export async function planContentLogArchive(projectRoot:string,options:ContentLogArchiveOptions):Promise<ContentLogArchivePlan>{
  if(!Array.isArray(options?.directories)||!options.directories.length||options.directories.length>20||!Array.isArray(options.closedDirectories))throw new Error('请选择1至20个已封闭历史日志目录');
  const directories=[...new Set(options.directories.map(logDirectory))].sort(),closed=new Set(options.closedDirectories.map(logDirectory)),active=new Set((options.activeDirectories??[]).map(logDirectory)),rebuildable=new Set((options.rebuildableDirectories??[]).map(logDirectory));
  const entries:ContentLogArchiveEntry[]=[];let count=0,totalBytes=0;
  for(const directory of directories){options.signal?.throwIfAborted();const entry:ContentLogArchiveEntry={directory,eligible:false,files:[],bytes:0,rebuildable:rebuildable.has(directory)};entries.push(entry);
    try{
      if(!closed.has(directory))throw new Error('目录尚未明确封闭');if(active.has(directory)||protectedPath(directory))throw new Error('活动或受保护目录不可归档');
      const absolute=path.join(projectRoot,directory),stat=await fs.lstat(absolute);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('日志目录不是普通目录');
      await checkDirectoryPolicy(absolute,options.signal);const files=await archiveTree(absolute,options.signal);if(!files.length)throw new Error('日志目录为空');
      for(const name of files){const key=`${directory}/${name}`;if(protectedPath(name)||!diagnosticFile(name)||await privateEvidence(projectRoot,key))throw new Error('日志包含活动、恢复、源码、工具、浏览器、私有或未知类型材料');
        const file=await containedFile(projectRoot,key),s=await fs.stat(file);entry.files.push({path:key,bytes:s.size,sha256:await archiveFileHash(file,options.signal)});entry.bytes+=s.size;count++;if(count>4096||totalBytes+entry.bytes>MAX)throw new Error('日志归档超过大小或数量上限');}
      entry.eligible=true;totalBytes+=entry.bytes;
    }catch(error){options.signal?.throwIfAborted();entry.reason=publicValue(error instanceof Error?error.message:'日志目录不可归档');}
  }
  const planId=crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');return {version:1,planId,generatedAt:new Date().toISOString(),entries,totalBytes};
}
function archiveId(id:string):string{if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('日志归档标识无效');return id;}
async function readRecord(root:string,id:string):Promise<LogRecord>{
  const file=await containedFile(root,`.log-archives/${archiveId(id)}.json`);if((await fs.stat(file)).size>4*1024*1024)throw new Error('日志归档清单超过上限');const record=JSON.parse(await fs.readFile(file,'utf8')) as LogRecord;
  if(record.version!==1||record.archiveId!==id||!/^[a-f0-9]{64}$/.test(record.planId)||record.zip?.path!==`${id}.zip`||!/^[a-f0-9]{64}$/.test(record.zip.sha256)||!Array.isArray(record.directories)||!record.directories.length||record.directories.length>20||!Array.isArray(record.removedDirectories))throw new Error('日志归档清单损坏');
  for(const d of record.directories)logDirectory(d);if(record.removedDirectories.some(d=>!record.directories.includes(d)))throw new Error('日志归档移除记录无效');
  if(!Array.isArray(record.zip.entries)||record.zip.entries.some(e=>!record.directories.some(d=>e.path.startsWith(`${d}/`))||protectedPath(e.path)||!diagnosticFile(e.path)))throw new Error('日志归档条目越界或受保护');return record;
}
async function zipValue(root:string,record:LogRecord):Promise<VerifiedZip>{return {...record.zip,path:await containedFile(root,`.log-archives/${record.zip.path}`)};}
function display(root:string,record:LogRecord):ContentLogArchiveItem{return {archiveId:record.archiveId,createdAt:record.createdAt,directories:record.directories,removedDirectories:record.removedDirectories,zipPath:path.join(root,'.log-archives',record.zip.path),bytes:record.zip.bytes,sha256:record.zip.sha256};}
export async function archiveContentLogs(projectRoot:string,options:ContentLogArchiveOptions & {expectedPlanId:string;removeSource?:boolean}):Promise<ContentLogArchiveItem>{
  if(!options||typeof options!=='object'||Array.isArray(options)||options.removeSource!==undefined&&typeof options.removeSource!=='boolean')throw new Error('removeSource必须为明确的布尔值');
  return withOrganizationLock(projectRoot,'log-archive',async()=>{
    const plan=await planContentLogArchive(projectRoot,options);if(plan.planId!==options.expectedPlanId)throw new Error('日志归档计划已变化，请重新规划');if(plan.entries.some(e=>!e.eligible))throw new Error('选中日志中存在不可归档目录');if(options.removeSource===true&&plan.entries.some(e=>!e.rebuildable))throw new Error('只有明确可重建的封闭日志才允许移除源目录');
    const existing:string[]=await fs.readdir(path.join(projectRoot,'.log-archives')).catch(e=>{if(e.code==='ENOENT')return [];throw e;});if(existing.length>10000)throw new Error('日志归档数量超过上限');let record:LogRecord|undefined;
    for(const name of existing.filter(n=>n.endsWith('.json'))){const prior=await readRecord(projectRoot,name.slice(0,-5));if(prior.planId===plan.planId){record=prior;break;}}
    const id=record?.archiveId??crypto.randomUUID(),destination=await writableFile(projectRoot,`.log-archives/${id}.zip`),zip=record?await zipValue(projectRoot,record):await writeVerifiedZip(projectRoot,destination,{signal:options.signal,files:plan.entries.flatMap(e=>e.files.map(f=>f.path)),compressSmallFiles:true});
    if(record){if(await archiveFileHash(zip.path,options.signal)!==zip.sha256)throw new Error('已有归档损坏，源材料未动');await verifyContentZip(zip.path,zip.entries,options.signal);}
    for(const entry of zip.entries){const planned=plan.entries.flatMap(e=>e.files).find(e=>e.path===entry.path);if(!planned||planned.bytes!==entry.bytes||planned.sha256!==entry.sha256)throw new Error('ZIP与计划逐文件哈希不一致');}
    record??={version:1,archiveId:id,planId:plan.planId,createdAt:new Date().toISOString(),directories:plan.entries.map(e=>e.directory),removedDirectories:[],zip:{...zip,path:`${id}.zip`}};
    const manifest=await writableFile(projectRoot,`.log-archives/${id}.json`);await atomicJson(manifest,record);
    if(options.removeSource===true){const fresh=await planContentLogArchive(projectRoot,options);if(fresh.planId!==plan.planId)throw new Error('归档已保留，但源日志变化，未移除');if(await archiveFileHash(zip.path,options.signal)!==zip.sha256)throw new Error('ZIP变化，未移除源日志');
      for(const entry of plan.entries){options.signal?.throwIfAborted();const source=await fs.realpath(path.join(projectRoot,entry.directory)),logs=await fs.realpath(path.join(projectRoot,'logs'));if(path.dirname(source)!==logs||!(await fs.lstat(path.join(projectRoot,entry.directory))).isDirectory()||(await fs.lstat(path.join(projectRoot,entry.directory))).isSymbolicLink())throw new Error('源日志归属异常，归档已保留');
        // The verified ZIP and durable restore manifest already exist, even if removal is interrupted.
        await fs.rm(source,{recursive:true,force:false});if(!record.removedDirectories.includes(entry.directory))record.removedDirectories.push(entry.directory);await atomicJson(manifest,record);
      }
    }
    return display(projectRoot,record);
  },options.signal);
}
export async function listContentLogArchives(projectRoot:string):Promise<ContentLogArchiveItem[]>{
  const directory=path.join(projectRoot,'.log-archives'),stat=await fs.lstat(directory).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});if(!stat)return [];if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('日志归档目录无效');const names=await fs.readdir(directory);if(names.length>10000)throw new Error('日志归档数量超过上限');const result:ContentLogArchiveItem[]=[];
  for(const name of names.sort()){if(!name.endsWith('.json'))continue;const record=await readRecord(projectRoot,name.slice(0,-5));result.push(display(projectRoot,record));}return result.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}
export async function restoreContentLogArchive(projectRoot:string,id:string,options:{signal?:AbortSignal}={}):Promise<{archiveId:string;restoredDirectories:string[];existingDirectories:string[]}>{
  return withOrganizationLock(projectRoot,'log-archive',async()=>{
    const record=await readRecord(projectRoot,id),zip=await zipValue(projectRoot,record),temporary=path.dirname(await writableFile(projectRoot,`.log-archives/restore-${crypto.randomUUID()}/validation`));const restoredDirectories:string[]=[],existingDirectories:string[]=[];
    try{
      await extractContentZip(zip,temporary,options.signal);
      for(const directory of record.directories){const target=path.join(projectRoot,directory),files=zip.entries.filter(e=>e.path.startsWith(`${directory}/`));
        const stat=await fs.lstat(target).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});
        if(stat){if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('恢复目标不是普通目录');const current=await archiveTree(target,options.signal),expected=files.map(e=>e.path.slice(directory.length+1));if(current.length!==expected.length||current.some(p=>!expected.includes(p)))throw new Error('恢复目标已有不同材料，不覆盖');for(const e of files)if(await archiveFileHash(await containedFile(projectRoot,e.path),options.signal)!==e.sha256)throw new Error('恢复目标已有不同材料，不覆盖');existingDirectories.push(directory);continue;}
        const destination=await writableFile(projectRoot,`${directory}/validation`);await fs.rmdir(path.dirname(destination));options.signal?.throwIfAborted();await fs.rename(path.join(temporary,directory),target);restoredDirectories.push(directory);
      }
      return {archiveId:id,restoredDirectories,existingDirectories};
    }finally{const real=await fs.realpath(temporary),base=await fs.realpath(path.join(projectRoot,'.log-archives'));if(path.dirname(real)!==base||!path.basename(real).startsWith('restore-'))throw new Error('恢复暂存目录归属异常');await fs.rm(real,{recursive:true,force:true});}
  },options.signal);
}

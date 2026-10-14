import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {isContentWorkerActive,tryContentMaintenance} from './content-jobs.js';
import {publicValue} from './content-library.js';
import type {ContentAsset,ContentManifest,ContentJob} from './content-types.js';

export interface ContentStorageOptions {signal?:AbortSignal;}
export interface ContentStorageFile {path:string;bytes:number;decision:'reclaim'|'retain';reason:string;assetId?:string;}
export interface ContentStorageEntry {jobId:string;state:string;contentId?:string;files:ContentStorageFile[];bytes:number;reclaimableBytes:number;}
export interface ContentStoragePlan {version:1;planId:string;generatedAt:string;workerActive:boolean;jobIds:string[];entries:ContentStorageEntry[];totalBytes:number;reclaimableBytes:number;reclaimableFiles:number;retainedFiles:number;reason?:string;}
export interface ContentStorageCleanupOptions extends ContentStorageOptions {jobIds:string[];expectedPlanId?:string;}
export interface ContentStorageCleanupResult {ok:boolean;reason?:string;reclaimedBytes:number;reclaimedFiles:number;removedJobIds:string[];plan:ContentStoragePlan;}

interface Evidence {bytes:number;sha256:string;stamp:string;}
interface TreeFile {path:string;bytes:number;stamp:string;kind:'file'|'link'|'other';}
interface ManifestEntry {directory:string;relative:string;digest:string;manifest:ContentManifest;}
interface Proof {jobId:string;stage:string;relative:string;source:Evidence;target:Evidence;asset:ContentAsset;item:ManifestEntry;}
interface Snapshot {plan:ContentStoragePlan;proofs:Proof[];queueDigest:string;directories:Map<string,string[]>;}
const terminal=new Set(['completed','partial','failed','cancelled','login_required']);
const safeJobId=(id:unknown):id is string=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(id);
const digest=(value:string|Buffer)=>crypto.createHash('sha256').update(value).digest('hex');
const stamp=(s:import('node:fs').Stats)=>`${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.birthtimeMs}`;
const reserved=(relative:string)=>relative.replaceAll('\\','/').split('/').some(part=>/^(?:versions|\.命名备份|\.命名整理|\.迁移备份)$/i.test(part)||/(?:^|[._-])(?:partial|pending|superseded|tmp|temp|bak|backup)(?:[._-]|$)/i.test(part))||/^derived\/proofs(?:\/|$)/i.test(relative.replaceAll('\\','/'));
function relativeKey(relative:string):string{
  if(!relative||/[<>:"|?*\x00-\x1f]/.test(relative)||path.isAbsolute(relative)||path.win32.isAbsolute(relative))throw new Error('unsafe_path');
  const parts=relative.replaceAll('\\','/').split('/');if(parts.some(p=>!p||p==='.'||p==='..'))throw new Error('unsafe_path');
  return parts.join('/');
}
/** Check every ancestor, including junctions pointing to another location inside the library. */
async function safeExisting(absolute:string,directory=false):Promise<string>{
  const full=path.resolve(absolute);let current=path.parse(full).root;
  const segments=path.relative(current,full).split(path.sep).filter(Boolean);
  for(let i=0;i<segments.length;i++){
    current=path.join(current,segments[i]);const s=await fs.lstat(current);
    if(s.isSymbolicLink()||(i<segments.length-1&&!s.isDirectory()))throw new Error('unsafe_path');
    if(i===segments.length-1&&(directory?!s.isDirectory():!s.isFile()))throw new Error('unsafe_path');
  }
  if(full===path.parse(full).root)throw new Error('unsafe_root');
  return full;
}
async function safeFile(base:string,relative:string):Promise<string>{return safeExisting(path.join(base,relativeKey(relative)));}
async function jsonFile(base:string,relative:string,limit=8*1024*1024):Promise<{data:any;digest:string}>{
  const file=await safeFile(base,relative);if((await fs.stat(file)).size>limit)throw new Error('metadata_too_large');
  const bytes=await fs.readFile(file);if(bytes.length>limit)throw new Error('metadata_too_large');return {data:JSON.parse(bytes.toString('utf8')),digest:digest(bytes)};
}
async function evidence(base:string,relative:string,signal?:AbortSignal):Promise<Evidence>{
  signal?.throwIfAborted();const file=await safeFile(base,relative),before=await fs.lstat(file),hash=crypto.createHash('sha256');
  for await(const chunk of createReadStream(file,{signal}))hash.update(chunk);
  const after=await fs.lstat(await safeFile(base,relative));if(stamp(before)!==stamp(after))throw new Error('file_changed');
  return {bytes:after.size,sha256:hash.digest('hex'),stamp:stamp(after)};
}
async function queue(root:string){
  const result=await jsonFile(root,'queue.json');if(result.data?.version!==1||!Array.isArray(result.data.jobs))throw new Error('queue_invalid');
  return {jobs:result.data.jobs as ContentJob[],digest:result.digest};
}
async function manifests(root:string):Promise<Map<string,ManifestEntry|null>>{
  const result=new Map<string,ManifestEntry|null>(),items=path.join(root,'items');
  try{await safeExisting(items,true);}catch{return result;}
  for(const entry of (await fs.readdir(items,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    if(!entry.isDirectory()||entry.isSymbolicLink())continue;
    try{
      const directory=await safeExisting(path.join(items,entry.name),true),read=await jsonFile(directory,'content.json'),m=read.data as ContentManifest;
      if(m.schemaVersion!==1||!/^[a-f0-9]{24}$/.test(m.contentId)||!Array.isArray(m.assets))continue;
      if(result.has(m.contentId)){result.set(m.contentId,null);continue;}
      result.set(m.contentId,{directory,relative:relativeKey(`items/${entry.name}/content.json`),digest:read.digest,manifest:m});
    }catch{/* Unreadable, linked and malformed formal items cannot cover a staging file. */}
  }
  return result;
}
async function tree(directory:string,signal?:AbortSignal):Promise<{files:TreeFile[];directories:string[]}>{
  const files:TreeFile[]=[],directories:string[]=[];
  async function visit(relative:string){
    signal?.throwIfAborted();const absolute=path.join(directory,relative),s=await fs.lstat(absolute);
    if(s.isSymbolicLink()){files.push({path:relative,bytes:0,stamp:stamp(s),kind:'link'});return;}
    if(s.isFile()){files.push({path:relative,bytes:s.size,stamp:stamp(s),kind:'file'});return;}
    if(!s.isDirectory()){files.push({path:relative,bytes:0,stamp:stamp(s),kind:'other'});return;}
    await safeExisting(absolute,true);directories.push(relative);
    for(const name of (await fs.readdir(absolute)).sort())await visit(relative?`${relative}/${name}`:name);
  }
  await visit('');return {files,directories};
}
function emptyPlan(reason?:string):ContentStoragePlan{return {version:1,planId:'',generatedAt:new Date().toISOString(),workerActive:false,jobIds:[],entries:[],totalBytes:0,reclaimableBytes:0,reclaimableFiles:0,retainedFiles:0,...(reason?{reason}:{})};}
async function inspect(root:string,options:ContentStorageOptions,ownsWorker=false):Promise<Snapshot>{
  options.signal?.throwIfAborted();const plan=emptyPlan(),proofs:Proof[]=[],directories=new Map<string,string[]>();let queueDigest='';
  try{await safeExisting(root,true);}catch{return {plan:{...plan,reason:'unsafe_or_missing_root'},proofs,queueDigest,directories};}
  try{
    if(await fs.lstat(path.join(root,'worker.lock')).then(()=>true,()=>false))await safeFile(root,'worker.lock');
    plan.workerActive=!ownsWorker&&await isContentWorkerActive(root);
    const data=await queue(root);queueDigest=data.digest;
    const catalog=await manifests(root),stageRoot=path.join(root,'staging');
    if(await fs.lstat(stageRoot).then(()=>true,()=>false)){
      await safeExisting(stageRoot,true);
      for(const entry of (await fs.readdir(stageRoot,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
        options.signal?.throwIfAborted();const matches=data.jobs.filter(job=>job.id===entry.name),job=matches.length===1?matches[0]:undefined;
        const item=job?.contentId?catalog.get(job.contentId):undefined,stage=path.join(stageRoot,entry.name);
        const summary:ContentStorageEntry={jobId:entry.name,state:job?.state??'unmanaged',...(item?{contentId:item.manifest.contentId}:{}),files:[],bytes:0,reclaimableBytes:0};plan.entries.push(summary);
        let collected:Awaited<ReturnType<typeof tree>>;
        try{await safeExisting(stage,true);collected=await tree(stage,options.signal);directories.set(entry.name,collected.directories);}catch{if(options.signal?.aborted)options.signal.throwIfAborted();summary.files.push({path:'',bytes:0,decision:'retain',reason:entry.isSymbolicLink()?'symbolic_link':'unreadable_stage'});continue;}
        for(const file of collected.files){
          const output:ContentStorageFile={path:file.path,bytes:file.bytes,decision:'retain',reason:'untracked_file'};summary.files.push(output);summary.bytes+=file.bytes;
          if(file.kind!=='file'){output.reason=file.kind==='link'?'symbolic_link':'non_regular_file';continue;}
          if(plan.workerActive){output.reason='worker_active';continue;}
          if(!job||!safeJobId(job.id)){output.reason='unmanaged_stage';continue;}
          if(!terminal.has(job.state)){output.reason='job_not_terminal';continue;}
          if(!item){output.reason='formal_manifest_missing_or_ambiguous';continue;}
          if(reserved(file.path)){output.reason='recovery_or_provenance_file';continue;}
          let assets:ContentAsset[];
          try{const key=relativeKey(file.path);assets=item.manifest.assets.filter(a=>typeof (a.capturePath??a.path)==='string'&&relativeKey(a.capturePath??a.path!)===key);}catch{output.reason='unsafe_asset_mapping';continue;}
          if(assets.length!==1){output.reason=assets.length?'ambiguous_asset_mapping':'untracked_file';continue;}
          const asset=assets[0];output.assetId=asset.id;
          if(asset.status!=='saved'||asset.integrityFailed||!asset.path||reserved(asset.path)||typeof asset.bytes!=='number'||!Number.isSafeInteger(asset.bytes)||asset.bytes<=0||!/^[a-f0-9]{64}$/i.test(asset.sha256??'')){output.reason='asset_not_verified_saved';continue;}
          try{
            const source=await evidence(stage,file.path,options.signal),target=await evidence(item.directory,asset.path,options.signal);
            if(source.bytes!==asset.bytes||target.bytes!==asset.bytes||source.sha256!==asset.sha256||target.sha256!==asset.sha256){output.reason='bytes_or_sha_mismatch';continue;}
            output.decision='reclaim';output.reason='formal_bytes_and_sha_match';summary.reclaimableBytes+=file.bytes;
            proofs.push({jobId:job.id,stage,relative:file.path,source,target,asset,item});
          }catch{if(options.signal?.aborted)options.signal.throwIfAborted();output.reason='file_unreadable_changed_or_linked';}
        }
      }
    }
  }catch{if(options.signal?.aborted)options.signal.throwIfAborted();plan.reason='unsafe_or_unreadable_metadata';for(const item of plan.entries){item.reclaimableBytes=0;for(const file of item.files)if(file.decision==='reclaim'){file.decision='retain';file.reason=plan.reason;}}proofs.length=0;}
  const all=plan.entries.flatMap(e=>e.files);plan.totalBytes=plan.entries.reduce((sum,e)=>sum+e.bytes,0);plan.reclaimableBytes=plan.entries.reduce((sum,e)=>sum+e.reclaimableBytes,0);plan.reclaimableFiles=all.filter(f=>f.decision==='reclaim').length;plan.retainedFiles=all.length-plan.reclaimableFiles;plan.jobIds=plan.entries.filter(e=>e.reclaimableBytes>0).map(e=>e.jobId);
  plan.planId=digest(JSON.stringify({root:path.resolve(root),queueDigest,workerActive:plan.workerActive,reason:plan.reason,entries:plan.entries,proofs:proofs.map(p=>({jobId:p.jobId,path:p.relative,source:p.source,target:p.target,manifest:p.item.digest}))}));
  return {plan:publicValue(plan),proofs,queueDigest,directories};
}

/** Read-only: no lock creation, queue recovery, renaming or deletion. */
export async function inspectContentStorage(root:string,options:ContentStorageOptions={}):Promise<ContentStoragePlan>{return (await inspect(path.resolve(root),options)).plan;}

/** Select by job ID, never caller-supplied file paths. Only verified copies are unlinked. */
export async function reclaimContentStaging(root:string,options:ContentStorageCleanupOptions):Promise<ContentStorageCleanupResult>{
  const ids=[...new Set(options.jobIds)];if(!ids.length||ids.some(id=>!safeJobId(id)))throw new Error('请选择有效的任务编号');
  options.signal?.throwIfAborted();
  const absolute=path.resolve(root),result:ContentStorageCleanupResult={ok:false,reclaimedBytes:0,reclaimedFiles:0,removedJobIds:[],plan:emptyPlan()};
  try{await safeExisting(absolute,true);if(await fs.lstat(path.join(absolute,'worker.lock')).then(()=>true,()=>false))await safeFile(absolute,'worker.lock');}
  catch{result.reason='unsafe_or_missing_root';result.plan.reason=result.reason;return result;}
  if(await isContentWorkerActive(absolute)){result.reason='worker_active';result.plan.workerActive=true;return result;}
  const locked=await tryContentMaintenance(absolute,async()=>{
    const snapshot=await inspect(absolute,options,true);result.plan=snapshot.plan;
    if(snapshot.plan.reason){result.reason=snapshot.plan.reason;return result;}
    if(options.expectedPlanId&&snapshot.plan.planId!==options.expectedPlanId){result.reason='plan_changed';return result;}
    const lockDigest=(await jsonFile(absolute,'worker.lock',4096)).digest,reclaimed=new Map<string,string[]>();
    const controlsChanged=async(proof:Proof):Promise<string|undefined>=>{
      if((await queue(absolute)).digest!==snapshot.queueDigest)return 'queue_changed';
      if((await jsonFile(absolute,'worker.lock',4096)).digest!==lockDigest)return 'maintenance_changed';
      if((await jsonFile(absolute,proof.item.relative)).digest!==proof.item.digest)return 'manifest_changed';
    };
    try{
      for(const proof of snapshot.proofs.filter(p=>ids.includes(p.jobId))){
        options.signal?.throwIfAborted();
        const changedBefore=await controlsChanged(proof);if(changedBefore){result.reason=changedBefore;return result;}
        const source=await evidence(proof.stage,proof.relative,options.signal),target=await evidence(proof.item.directory,proof.asset.path!,options.signal);
        if(JSON.stringify(source)!==JSON.stringify(proof.source)||JSON.stringify(target)!==JSON.stringify(proof.target)){result.reason='file_changed';return result;}
        const changedAfter=await controlsChanged(proof);if(changedAfter){result.reason=changedAfter;return result;}
        options.signal?.throwIfAborted();
        // Recheck ancestors and identity after hashing; never remove recursively.
        const sourceFile=await safeFile(proof.stage,proof.relative);if(stamp(await fs.lstat(sourceFile))!==source.stamp){result.reason='file_changed';return result;}
        await fs.unlink(sourceFile);result.reclaimedFiles++;result.reclaimedBytes+=source.bytes;
        reclaimed.set(proof.jobId,[...reclaimed.get(proof.jobId)??[],proof.relative]);
      }
      options.signal?.throwIfAborted();if((await queue(absolute)).digest!==snapshot.queueDigest){result.reason='queue_changed';return result;}
      for(const id of ids){
        const entry=snapshot.plan.entries.find(e=>e.jobId===id),deleted=reclaimed.get(id);if(!entry||!terminal.has(entry.state)||!deleted?.length)continue;
        for(const relative of [...snapshot.directories.get(id)??[]].sort((a,b)=>b.length-a.length)){
          if(relative&&(reserved(relative)||!deleted.some(file=>file.startsWith(relative+'/'))))continue;
          const directory=path.join(absolute,'staging',id,relative);
          try{await safeExisting(directory,true);await fs.rmdir(directory);if(!relative)result.removedJobIds.push(id);}catch{/* Nonempty, changed and linked directories remain. */}
        }
      }
      result.ok=true;return result;
    }catch{result.reason=options.signal?.aborted?'cancelled':'revalidation_or_delete_failed';return result;}
  });
  if(!locked.acquired){result.reason='worker_active';return result;}
  return locked.value;
}

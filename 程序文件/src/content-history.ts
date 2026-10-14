import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {atomicJson,containedFile,writableFile,publicValue} from './content-library.js';
import {getJobs,withContentQueueTransaction} from './content-jobs.js';
import type {ContentJob} from './content-types.js';

export interface ArchivedContentJob {archiveId:string;jobId:string;state:'completed'|'cancelled';title?:string;platform:ContentJob['platform'];contentId?:string;archivedAt:string;inQueue:boolean;}
interface HistoryRecord {version:1;archiveId:string;archivedAt:string;job:ContentJob;sha256:string;}
const safeId=(value:string)=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
const archivePattern=/^[a-zA-Z0-9_-]{1,128}\.[a-f0-9]{64}$/;
const hash=(job:ContentJob)=>crypto.createHash('sha256').update(JSON.stringify(job)).digest('hex');
function selection(ids:string[],archive=false):string[]{if(!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(id=>!(archive?archivePattern.test(id):safeId(id))))throw new Error('请选择1至100个有效任务标识');return [...new Set(ids)];}
function validate(record:HistoryRecord,id:string):void{
  if(record?.version!==1||record.archiveId!==id||!record.job||!safeId(record.job.id)||!['completed','cancelled'].includes(record.job.state)||record.sha256!==hash(record.job)||id!==`${record.job.id}.${record.sha256}`||!Number.isFinite(Date.parse(record.archivedAt)))throw new Error('任务历史损坏，已保留原文件');
}
async function read(root:string,id:string):Promise<HistoryRecord>{const file=await containedFile(root,`history/${id}.json`);if((await fs.stat(file)).size>1024*1024)throw new Error('任务历史超过单条上限');const result=JSON.parse(await fs.readFile(file,'utf8')) as HistoryRecord;validate(result,id);return result;}
function summary(record:HistoryRecord,inQueue:boolean):ArchivedContentJob{return publicValue({archiveId:record.archiveId,jobId:record.job.id,state:record.job.state as 'completed'|'cancelled',title:record.job.title,platform:record.job.platform,contentId:record.job.contentId,archivedAt:record.archivedAt,inQueue});}
/** A durable private snapshot comes before the atomic queue removal. Failed batches remain retryable. */
export async function archiveContentJobs(root:string,jobIds:string[]):Promise<{archived:ArchivedContentJob[];removedJobIds:string[]}>{
  const ids=selection(jobIds);return withContentQueueTransaction(root,async jobs=>{
    const records:HistoryRecord[]=[];const selected:ContentJob[]=[];
    for(const id of ids){const job=jobs.find(j=>j.id===id);if(!job){const history=await listArchivedContentJobs(root);const found=history.filter(h=>h.jobId===id).sort((a,b)=>b.archivedAt.localeCompare(a.archivedAt))[0];if(!found)throw new Error('选中任务不存在');records.push(await read(root,found.archiveId));continue;}
      if(!['completed','cancelled'].includes(job.state))throw new Error('只有已完成或已取消且不活动的任务可以归档');if(Buffer.byteLength(JSON.stringify(job))>1024*1024-1024)throw new Error('任务历史超过单条上限');selected.push(job);
      const sha256=hash(job),archiveId=`${id}.${sha256}`;let existing:HistoryRecord|undefined;try{existing=await read(root,archiveId);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      records.push(existing??{version:1,archiveId,archivedAt:new Date().toISOString(),job:structuredClone(job),sha256});
    }
    const historyPath=path.join(root,'history'),names:string[]=await fs.readdir(historyPath).catch(e=>{if(e.code==='ENOENT')return [];throw e;});if(names.length+records.filter(r=>!names.includes(`${r.archiveId}.json`)).length>50000)throw new Error('任务历史条目超过上限');
    for(const record of records){await atomicJson(await writableFile(root,`history/${record.archiveId}.json`),record);await read(root,record.archiveId);}
    const removed=new Set(selected.map(j=>j.id));for(let i=jobs.length-1;i>=0;i--)if(removed.has(jobs[i].id))jobs.splice(i,1);
    return {archived:records.map(r=>summary(r,false)),removedJobIds:[...removed]};
  });
}
export async function listArchivedContentJobs(root:string):Promise<ArchivedContentJob[]>{
  const directory=path.join(root,'history');const s=await fs.lstat(directory).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});if(!s)return [];if(!s.isDirectory()||s.isSymbolicLink())throw new Error('任务历史目录无效');
  const names=await fs.readdir(directory);if(names.length>50000)throw new Error('任务历史条目超过上限');const jobs=await getJobs(root,false),present=new Set(jobs.map(j=>j.id)),result:ArchivedContentJob[]=[];
  for(const name of names.sort()){if(!name.endsWith('.json'))continue;const id=name.slice(0,-5);if(!archivePattern.test(id))throw new Error('任务历史文件名无效');const record=await read(root,id);result.push(summary(record,present.has(record.job.id)));}
  return result.sort((a,b)=>b.archivedAt.localeCompare(a.archivedAt));
}
/** Never overwrite a newer queued/running/retried instance, and retain history for repeated recovery. */
export async function restoreArchivedContentJobs(root:string,archiveIds:string[]):Promise<{restoredJobIds:string[];existingJobIds:string[]}>{
  const ids=selection(archiveIds,true);return withContentQueueTransaction(root,async jobs=>{
    const records=await Promise.all(ids.map(id=>read(root,id))),byJob=new Map<string,HistoryRecord>();
    for(const record of records){const prior=byJob.get(record.job.id);if(prior&&prior.archiveId!==record.archiveId)throw new Error('同一任务不能同时恢复不同历史版本');byJob.set(record.job.id,record);}
    const additions=[...byJob.values()].filter(r=>!jobs.some(j=>j.id===r.job.id));if(jobs.length+additions.length>1000)throw new Error('恢复后任务列表将超过1000条上限');
    const restoredJobIds:string[]=[],existingJobIds:string[]=[];for(const record of byJob.values()){if(jobs.some(j=>j.id===record.job.id)){existingJobIds.push(record.job.id);continue;}jobs.push(structuredClone(record.job));restoredJobIds.push(record.job.id);}return {restoredJobIds,existingJobIds};
  });
}

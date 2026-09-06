import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
const runtime=process.cwd(),root=path.join(runtime,'logs','link-wechat-live');
await fs.mkdir(root,{recursive:true});
const env={...process.env,WECHAT_ARTICLE_READER_ROOT:runtime,WECHAT_ARTICLE_LIBRARY_ROOT:path.join(root,'legacy'),CONTENT_LIBRARY_ROOT:path.join(root,'library')};
async function cli(...args){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(runtime,'dist','link-cli.js'),...args],{env,cwd:runtime,windowsHide:true});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);child.on('close',code=>{try{const parsed=JSON.parse(stdout);if(code&&!parsed.ok)throw new Error(parsed.message);resolve(parsed);}catch(error){reject(new Error(`${error.message}; ${stderr.slice(-500)}`));}});});}
const queued=await cli('enqueue','https://mp.weixin.qq.com/s/QYn2OeBXhsO2O7XLwE0lfA');
for(const job of queued.jobs)if(!['queued','running'].includes(job.state))await cli('retry',job.id);
await cli('work');const jobs=await cli('jobs'),list=await cli('list');
const reports=[];for(const item of list.items){const read=await cli('read',item.contentId);reports.push({title:item.title,contentId:item.contentId,status:item.status,textLength:read.total,assets:read.manifest?.assets.map(({role,status,reason})=>({role,status,reason})),pdfExists:!!item.pdfPath});}
const report={checkedAt:new Date().toISOString(),jobs:jobs.jobs.map(({state,message,contentId})=>({state,message,contentId})),items:reports};
await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
if(!reports.some(item=>item.textLength>100))process.exitCode=1;

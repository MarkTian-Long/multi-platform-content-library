import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';
import {pathToFileURL} from 'node:url';

const runtime=process.cwd();
const root=path.join(runtime,'logs','link-live-check');
await fs.mkdir(root,{recursive:true});
const env={...process.env,WECHAT_ARTICLE_READER_ROOT:runtime,WECHAT_ARTICLE_LIBRARY_ROOT:path.join(root,'empty-legacy'),CONTENT_LIBRARY_ROOT:path.join(root,'library')};
async function cli(...args){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(runtime,'dist','link-cli.js'),...args],{env,cwd:runtime,windowsHide:true});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);child.on('close',code=>{try{const parsed=JSON.parse(stdout);if(code&&!parsed.ok)throw new Error(parsed.message);resolve(parsed);}catch(error){reject(new Error(`${error.message}; ${stderr.slice(-500)}`));}});});}
const queued=await cli('enqueue','https://example.com/');
for(const job of queued.jobs)if(!['queued','running'].includes(job.state))await cli('retry',job.id);
await cli('work');const jobs=await cli('jobs'),list=await cli('list','Example Domain');
if(!list.items.length)throw new Error('真实网页未出现在资料库');const item=list.items[0];
const read=await cli('read',item.contentId),exported=await cli('export',item.contentId);
const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
try{const page=await browser.newPage({viewport:{width:1180,height:850}});let networkRequests=0;await page.route(/^https?:\/\//,route=>{networkRequests++;return route.abort();});
await page.goto(pathToFileURL(item.readingPath).toString());const title=await page.title();await page.screenshot({path:path.join(root,'offline-reading.png'),fullPage:true});
const report={checkedAt:new Date().toISOString(),jobs:jobs.jobs.map(({id,state,message})=>({id,state,message})),title,source:item.sourceUrl,bodyContainsExpected:read.text.includes('documentation'),pdfExists:!!item.pdfPath&&await fs.stat(item.pdfPath).then(s=>s.size>0,()=>false),networkRequests,exportDirectory:exported.directory};
await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));if(!report.bodyContainsExpected||!report.pdfExists||networkRequests)throw new Error('离线资料/PDF验收未通过');console.log(JSON.stringify(report));
}finally{await browser.close();}

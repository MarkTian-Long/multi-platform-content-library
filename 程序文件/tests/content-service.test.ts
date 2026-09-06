import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { processContentJob,listSavedContent } from "../src/content-service.js";
import { enqueueInputs,getJobs } from "../src/content-jobs.js";
import { findContent,readContent,saveContent } from "../src/content-library.js";
import type { CapturedContent } from "../src/content-types.js";
import { saveArticle } from "../src/article-library.js";
async function fixture(t:any){const root=await fs.mkdtemp(path.join(os.tmpdir(),"link-service-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));const [job]=await enqueueInputs(root,[{platform:"web",url:"https://example.com/article",canonicalUrl:"https://example.com/article"}]);return {root,job};}
const base:CapturedContent={platform:"web",sourceUrl:"https://example.com/article",canonicalUrl:"https://example.com/article",title:"示例",kind:"article",capturedAt:"2026-09-06T00:00:00Z",markdown:"原始文字",assets:[],warnings:[]};
test("pipeline persists original content before enrichment fails",async t=>{
 const {root,job}=await fixture(t);await assert.rejects(processContentJob(path.join(root,"runtime"),root,job,new AbortController().signal,{resolve:async i=>i,acquire:async(i,c)=>{await c.onCheckpoint?.(base);return base;},enrich:async()=>{throw new Error("识别失败");},pdf:async()=>undefined}),/识别失败/);
 assert.equal((await findContent(root)).length,1);assert.ok((await getJobs(root))[0].contentId);
 assert.equal((await findContent(root))[0].status,"partial");
});
test("successful retry clears resolved login placeholders",async t=>{
 const {root,job}=await fixture(t);const deps={resolve:async(i:any)=>i,enrich:async(r:CapturedContent)=>r,pdf:async()=>undefined};
 const login=await processContentJob(root,root,job,new AbortController().signal,{...deps,acquire:async()=>({...base,markdown:"",assets:[{id:"login",role:"source",status:"login_required"}]})});assert.equal(login.state,"login_required");
 const saved=await processContentJob(root,root,job,new AbortController().signal,{...deps,acquire:async()=>base});assert.equal(saved.state,"completed");
});
test("copying reusable assets refuses a staging junction before writing",async t=>{
 const {root,job}=await fixture(t);const source=path.join(root,"source");await fs.mkdir(path.join(source,"images"),{recursive:true});await fs.writeFile(path.join(source,"images","1.png"),"image");
 await saveContent(root,{...base,assets:[{id:"i",role:"image",status:"saved",path:"images/1.png"}]},source);
 const stage=path.join(root,"staging",job.id),outside=path.join(root,"outside");await fs.mkdir(stage,{recursive:true});await fs.mkdir(outside);await fs.symlink(outside,path.join(stage,"images"),"junction");
 try{await processContentJob(root,root,job,new AbortController().signal,{resolve:async i=>i,acquire:async()=>base,enrich:async r=>r,pdf:async()=>undefined});}catch{}
 assert.deepEqual(await fs.readdir(outside),[]);
});
test("pipeline returns partial for missing OCR while original remains readable",async t=>{
 const {root,job}=await fixture(t);const result=await processContentJob(root,root,job,new AbortController().signal,{resolve:async i=>i,acquire:async()=>base,enrich:async r=>({...r,assets:[{id:"ocr",role:"ocr",status:"missing_dependency",reason:"缺引擎"}]}),pdf:async()=>undefined});
 assert.equal(result.state,"partial");const read=await readContent(root,result.contentId!);assert.equal(read.ok,true);if(read.ok)assert.match(read.text,/原始文字/);
});

test("legacy import takes the latest version once and leaves the old library untouched",async t=>{
 const {root}=await fixture(t),legacy=path.join(root,"legacy"),library=path.join(root,"library");
 const priorEnv=process.env.WECHAT_ARTICLE_LIBRARY_ROOT;process.env.WECHAT_ARTICLE_LIBRARY_ROOT=legacy;t.after(()=>{if(priorEnv===undefined)delete process.env.WECHAT_ARTICLE_LIBRARY_ROOT;else process.env.WECHAT_ARTICLE_LIBRARY_ROOT=priorEnv;});
 const sourceUrl="https://mp.weixin.qq.com/s/same-article";
 await saveArticle(legacy,{title:"旧版",sourceUrl,extractedAt:"2026-09-01T00:00:00Z",status:"complete",markdown:"这是旧版"});
 const newest=await saveArticle(legacy,{title:"新版",sourceUrl,extractedAt:"2026-09-06T00:00:00Z",status:"complete",markdown:"这是新版"});
 const before=await fs.readFile(path.join(newest.directory,"manifest.json"),"utf8");
 const first=await listSavedContent(root,library),second=await listSavedContent(root,library);
 assert.equal(first.length,1);assert.equal(first[0].title,"新版");assert.deepEqual(first,second);
 const read=await readContent(library,first[0].contentId);if(!read.ok)assert.fail(read.reason);assert.match(read.text,/这是新版/);assert.doesNotMatch(read.text,/这是旧版/);
 assert.equal(await fs.readFile(path.join(newest.directory,"manifest.json"),"utf8"),before);
});

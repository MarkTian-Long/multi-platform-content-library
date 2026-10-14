import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {enqueueInputs,getJobs,runJobs,retryJob,cancelJob,updateJob,isContentWorkerActive,withContentQueueTransaction} from "../src/content-jobs.js";
import {processContentJob} from "../src/content-service.js";
import {findContent,readContent} from "../src/content-library.js";
import {youtubeRetryAfter} from "../src/content-youtube-retry.js";
import {runLinkCli} from "../src/link-cli.js";
import type {CapturedContent,ContentInput} from "../src/content-types.js";

const youtube=(id="jNQXAC9IVRw"):ContentInput=>({platform:"youtube",nativeId:id,url:`https://www.youtube.com/watch?v=${id}`,canonicalUrl:`https://www.youtube.com/watch?v=${id}`,processing:"original"});
const web=(id:string):ContentInput=>({platform:"web",url:`https://example.com/${id}`,canonicalUrl:`https://example.com/${id}`,processing:"original"});
async function fixture(t:any){const root=await fs.mkdtemp(path.join(os.tmpdir(),"youtube-retry-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
const limited=(until?:string)=>({state:"partial" as const,message:"HTTP 429",youtubeRateLimit:until?{retryAfter:until}:{}});

test("429 persists a shared cooldown, releases worker, and lets other platforms complete",async t=>{
  const root=await fixture(t),jobs=await enqueueInputs(root,[youtube(),youtube("BaW_jenozKc"),web("first")]);
  let now=Date.now(),calls:string[]=[];
  const handler=async(job:any)=>{calls.push(job.id);return job.platform==="youtube"?limited():{state:"completed" as const};};
  await runJobs(root,handler,undefined,{now:()=>now});
  let saved=await getJobs(root);
  assert.deepEqual(saved.map(j=>j.state),["waiting","waiting","completed"]);
  assert.deepEqual(calls,[jobs[0].id,jobs[2].id]);
  assert.equal(await isContentWorkerActive(root),false);
  const initial=JSON.parse(await fs.readFile(path.join(root,"queue.json"),"utf8")).youtubeCooldown;
  assert.ok(Date.parse(initial.until)>=now+5*60000);
  await updateJob(root,jobs[2].id,{message:"保留其他资料"});
  await withContentQueueTransaction(root,async list=>{list[2].title="历史事务不丢冷却";});
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,"queue.json"),"utf8")).youtubeCooldown,initial);
  await retryJob(root,jobs[0].id);
  await enqueueInputs(root,[web("second")]);
  await runJobs(root,handler,undefined,{now:()=>now});
  assert.equal(calls.filter(id=>id===jobs[0].id).length,1);
  assert.equal((await getJobs(root)).at(-1)?.state,"completed");
  now=Date.parse(initial.until)+1;
  await runJobs(root,async job=>{calls.push(job.id);return {state:"completed",youtubeAccessRestored:job.platform==="youtube"};},undefined,{now:()=>now});
  saved=await getJobs(root);
  assert.ok(saved.every(j=>j.state==="completed"));
  assert.equal(JSON.parse(await fs.readFile(path.join(root,"queue.json"),"utf8")).youtubeCooldown,undefined);
});

test("Retry-After extends cooldown and cancellation retains prior saved identity",async t=>{
  const root=await fixture(t),[job]=await enqueueInputs(root,[youtube()]);let now=Date.now();
  const until=new Date(now+2*3600000).toISOString();
  await updateJob(root,job.id,{contentId:"a".repeat(24)});
  await runJobs(root,async()=>limited(until),undefined,{now:()=>now});
  const waiting:any=(await getJobs(root))[0];assert.equal(waiting.retry.notBefore,until);
  await cancelJob(root,job.id);assert.equal((await getJobs(root))[0].state,"cancelled");
  assert.equal((await getJobs(root))[0].contentId,"a".repeat(24));
  await retryJob(root,job.id);let calls=0;
  now+=60000;
  await runJobs(root,async()=>{calls++;return {state:"completed"};},undefined,{now:()=>now});
  assert.equal(calls,0);assert.equal((await getJobs(root))[0].state,"waiting");
});

test("three automatic resumptions are bounded, further 429 requires an explicit retry",async t=>{
  const root=await fixture(t),[job]=await enqueueInputs(root,[youtube()]);let now=Date.now(),calls=0;
  for(let i=1;i<=4;i++){
    await runJobs(root,async()=>{calls++;return limited();},undefined,{now:()=>now});
    const item:any=(await getJobs(root))[0];
    assert.equal(item.state,i<=3?"waiting":"rate_limited");
    assert.equal(item.retry.automatic,i<=3);
    if(i<=3)now=Date.parse(item.retry.notBefore)+1;
  }
  await enqueueInputs(root,[youtube("BaW_jenozKc")]);
  await runJobs(root,async()=>{calls++;return {state:"completed"};},undefined,{now:()=>now+3600000});
  assert.equal(calls,4);
  assert.equal((await getJobs(root))[1].state,"rate_limited");
  await retryJob(root,job.id);
  await runJobs(root,async()=>{calls++;return {state:"completed",youtubeAccessRestored:true};},undefined,{now:()=>now});
  assert.equal(calls,4,"explicit retry still observes the existing cooldown");
  now+=3600000;
  await runJobs(root,async()=>{calls++;return {state:"completed",youtubeAccessRestored:true};},undefined,{now:()=>now});
  assert.equal(calls,5);assert.equal((await getJobs(root))[0].state,"completed");
  assert.equal((await getJobs(root))[1].state,"rate_limited","unselected manually paused job stays paused");
});

test("429 checkpoint returns structured scheduling intent without enriching or deleting saved content",async t=>{
  const root=await fixture(t),[job]=await enqueueInputs(root,[youtube()]);let enrichment=0;
  const record:CapturedContent={platform:"youtube",nativeId:job.input.nativeId,sourceUrl:job.input.url,canonicalUrl:job.input.canonicalUrl,title:"YouTube sample",kind:"video",capturedAt:new Date().toISOString(),markdown:"已经取得的描述",assets:[{id:"video/001",role:"video",status:"unavailable",reason:"HTTP 429",provenance:"original"}],warnings:["HTTP 429"],coverage:{access:"rate_limited",retryAfter:new Date(Date.now()+3600000).toISOString()}};
  const result:any=await processContentJob(root,root,job,new AbortController().signal,{resolve:async i=>i,acquire:async()=>record,enrich:async r=>{enrichment++;return r;},pdf:async()=>{throw new Error("must not generate PDF");}});
  assert.equal(result.youtubeRateLimit.retryAfter,record.coverage!.retryAfter);assert.equal(enrichment,0);
  const item=(await findContent(root))[0];assert.ok(item);const read=await readContent(root,item.contentId);assert.equal(read.ok,true);if(read.ok)assert.match(read.text,/已经取得的描述/);
});

test("verification-required content stops rather than scheduling an automatic retry",async t=>{
  const root=await fixture(t),[job]=await enqueueInputs(root,[youtube()]);
  const record:CapturedContent={platform:"youtube",nativeId:job.input.nativeId,sourceUrl:job.input.url,canonicalUrl:job.input.canonicalUrl,title:"YouTube",kind:"video",capturedAt:new Date().toISOString(),markdown:"",assets:[{id:"video/001",role:"video",status:"login_required",reason:"Sign in to confirm you're not a bot"}],warnings:[],coverage:{access:"verification_required"}};
  const result:any=await processContentJob(root,root,job,new AbortController().signal,{resolve:async i=>i,acquire:async()=>record});
  assert.equal(result.state,"login_required");assert.equal(result.youtubeRateLimit,undefined);
});

test("Retry-After delay and HTTP-date are accepted, malformed or expired values are ignored",()=>{
  const now=Date.parse("2026-10-14T12:00:00.000Z");
  assert.equal(youtubeRetryAfter("3600",now),"2026-10-14T13:00:00.000Z");
  assert.equal(youtubeRetryAfter("Wed, 14 Oct 2026 14:00:00 GMT",now),"2026-10-14T14:00:00.000Z");
  for(const value of [null,"0","-1","1.5","Infinity","99999999999999999999999999999","2026-10-15","Tue, 13 Oct 2026 12:00:00 GMT"])assert.equal(youtubeRetryAfter(value,now),undefined);
});

test("automatic worker only restores scheduled jobs and never starts newly queued unrelated input",async t=>{
  const root=await fixture(t),[job]=await enqueueInputs(root,[youtube()]);let now=Date.now();
  await runJobs(root,async()=>limited(),undefined,{now:()=>now});
  const waiting:any=(await getJobs(root))[0];
  await enqueueInputs(root,[web("only-enqueued"),youtube("BaW_jenozKc")]);
  const newJob=(await getJobs(root))[2];assert.equal(newJob.state,"queued");assert.equal(newJob.retry?.automatic,false);
  now=Date.parse(waiting.retry.notBefore)+1;const calls:string[]=[];
  await runJobs(root,async item=>{calls.push(item.id);return {state:"completed",youtubeAccessRestored:true};},undefined,{now:()=>now,scheduledOnly:true});
  assert.deepEqual(calls,[job.id]);assert.deepEqual((await getJobs(root)).map(j=>j.state),["completed","queued","queued"]);
});

test("CLI reports persisted waiting counts, due time and no immediately runnable YouTube request",async t=>{
  const root=await fixture(t);await enqueueInputs(root,[youtube()]);
  await runJobs(root,async()=>limited());
  const output=await runLinkCli(["jobs"],{root,runtimeRoot:root});
  assert.equal(output.ok,true);assert.equal(output.readyCount,0);assert.equal(output.waitingCount,1);assert.ok(typeof output.nextWakeAt==="string");
  const work=await runLinkCli(["work","--scheduled"],{root,runtimeRoot:root});
  assert.equal(work.ok,true);assert.equal(work.waitingCount,1);assert.equal(work.readyCount,0);assert.equal((await getJobs(root))[0].attempts,1);
});

test("malformed persisted cooldown cannot be overwritten or treated as permission to request",async t=>{
  const root=await fixture(t);await enqueueInputs(root,[youtube()]);const file=path.join(root,"queue.json");
  const document=JSON.parse(await fs.readFile(file,"utf8"));document.youtubeCooldown={until:"tomorrow",failures:1,paused:false};
  const bytes=JSON.stringify(document);await fs.writeFile(file,bytes);let calls=0;
  await assert.rejects(runJobs(root,async()=>{calls++;return {state:"completed"};}),/任务列表损坏/);
  assert.equal(calls,0);assert.equal(await fs.readFile(file,"utf8"),bytes);
});

test("cancellation at the result boundary wins while the observed platform cooldown survives",async t=>{
  const root=await fixture(t),[job]=await enqueueInputs(root,[youtube()]);
  await runJobs(root,async()=>{await cancelJob(root,job.id);return limited();});
  assert.equal((await getJobs(root))[0].state,"cancelled");
  assert.ok(JSON.parse(await fs.readFile(path.join(root,"queue.json"),"utf8")).youtubeCooldown);
});

test("a cancellation committed between an exception snapshot and its final queue lock remains cancelled",async t=>{
  const root=await fixture(t),[job]=await enqueueInputs(root,[youtube()]);
  const io=fs as any,read=io.readFile,open=io.open;let armed=false,intercepted=0;
  const queue=path.join(root,"queue.json"),mutex=path.join(root,"queue.lock");
  async function cancelAtBoundary(){armed=false;intercepted++;await cancelJob(root,job.id);}
  io.readFile=async(file:unknown,...args:any[])=>{
    const bytes=await read(file,...args);
    if(armed&&file===queue&&!await fs.stat(mutex).then(()=>true,()=>false))await cancelAtBoundary();
    return bytes;
  };
  io.open=async(file:unknown,...args:any[])=>{
    if(armed&&file===mutex&&args[0]==="wx")await cancelAtBoundary();
    return open(file,...args);
  };
  try {
    await runJobs(root,async()=>{armed=true;throw new Error("network closed at the cancellation boundary");});
  } finally {armed=false;io.readFile=read;io.open=open;}
  assert.equal(intercepted,1);const saved=(await getJobs(root))[0];
  assert.equal(saved.cancelRequested,true);assert.equal(saved.state,"cancelled");
});

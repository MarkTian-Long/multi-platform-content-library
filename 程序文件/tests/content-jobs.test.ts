import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enqueueInputs, getJobs, cancelJob, retryJob, runJobs, updateJob } from "../src/content-jobs.js";
const input=(id:string)=>({url:`https://example.com/${id}`,canonicalUrl:`https://example.com/${id}`,platform:"web" as const});
async function root(t:any){const value=await fs.mkdtemp(path.join(os.tmpdir(),"link-jobs-"));t.after(()=>fs.rm(value,{recursive:true,force:true}));return value;}
test("concurrent enqueue is durable and does not lose or duplicate jobs",async t=>{const r=await root(t);await Promise.all([enqueueInputs(r,[input("a"),input("b")]),enqueueInputs(r,[input("a"),input("c")])]);assert.equal((await getJobs(r)).length,3);});
test("one failed job does not stop later items and retry only selects that job",async t=>{
 const r=await root(t);const jobs=await enqueueInputs(r,[input("a"),input("b")]);let calls=0;
 await runJobs(r,async job=>{calls++;if(job.id===jobs[0].id)throw new Error("network");return {state:"completed",message:"完成"};});
 assert.deepEqual((await getJobs(r)).map(j=>j.state),["failed","completed"]);await retryJob(r,jobs[0].id);
 await runJobs(r,async()=>{calls++;return {state:"completed",message:"完成"};});assert.equal(calls,3);
});
test("cancelled work retains its checkpoint and can resume",async t=>{
 const r=await root(t);const [job]=await enqueueInputs(r,[input("a")]);
 await runJobs(r,async(item,signal)=>{await updateJob(r,item.id,{contentId:"a".repeat(24),message:"首个文件已保存"});await cancelJob(r,item.id);await new Promise<void>(resolve=>signal.addEventListener("abort",()=>resolve(),{once:true}));throw new DOMException("cancelled","AbortError");});
 const [cancelled]=await getJobs(r);assert.equal(cancelled.state,"cancelled");assert.equal(cancelled.contentId,"a".repeat(24));
 await retryJob(r,job.id);assert.equal((await getJobs(r))[0].state,"queued");
});
test("dead worker jobs become paused, never falsely complete",async t=>{
 const r=await root(t);const [job]=await enqueueInputs(r,[input("a")]);await updateJob(r,job.id,{state:"running"});assert.equal((await getJobs(r))[0].state,"paused");
});
test("persisted cancellation wins over an immediate ordinary failure",async t=>{const r=await root(t);const [job]=await enqueueInputs(r,[input("a")]);await runJobs(r,async()=>{await cancelJob(r,job.id);throw new Error("network closed");});assert.equal((await getJobs(r))[0].state,"cancelled");});
test("a job cancelled before claiming never invokes its handler",async t=>{const r=await root(t);const [job]=await enqueueInputs(r,[input("a")]);await cancelJob(r,job.id);let called=false;await runJobs(r,async()=>{called=true;return {state:"completed"};});assert.equal(called,false);});

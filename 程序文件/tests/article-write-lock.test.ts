import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { withContentMaintenance } from "../src/content-jobs.js";
import { inheritedArticleWorker,ownedArticleWorkerToken } from "../src/article-write-lock.js";
test("only a direct parent with the exact worker token can lend its lock to capture",async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),"article-worker-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));assert.equal(await inheritedArticleWorker(root),false);await withContentMaintenance(root,async()=>{const token=await ownedArticleWorkerToken(root);assert.ok(token);const env={CONTENT_LIBRARY_NATIVE_CAPTURE:"1",CONTENT_LIBRARY_PARENT_WORKER_TOKEN:token};assert.equal(await inheritedArticleWorker(root,env,process.pid),true);assert.equal(await inheritedArticleWorker(root,{...env,CONTENT_LIBRARY_PARENT_WORKER_TOKEN:"bad"},process.pid),false);assert.equal(await inheritedArticleWorker(root,env,process.pid+100),false);assert.equal(await inheritedArticleWorker(root,{CONTENT_LIBRARY_NATIVE_CAPTURE:"1"},process.pid),false);await assert.rejects(withContentMaintenance(root,async()=>{}),/已有任务/);});assert.equal(await ownedArticleWorkerToken(root),undefined);await fs.writeFile(path.join(root,"worker.lock"),"bad-json");assert.equal(await inheritedArticleWorker(root,{CONTENT_LIBRARY_NATIVE_CAPTURE:"1",CONTENT_LIBRARY_PARENT_WORKER_TOKEN:"invalid"}),false);});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runLinkCli } from "../src/link-cli.js";
test("CLI queues share text, redacts tokens and persists usable internal URL",async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"link-cli-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const result=await runLinkCli(["enqueue","分享 https://www.xiaohongshu.com/explore/123456789012345678901234?xsec_token=SECRET"],{root,runtimeRoot:root});
 assert.equal(result.ok,true);assert.doesNotMatch(JSON.stringify(result),/SECRET/);assert.match(await fs.readFile(path.join(root,"queue.json"),"utf8"),/SECRET/);
 const jobs=await runLinkCli(["jobs"],{root,runtimeRoot:root});assert.equal((jobs.jobs as unknown[]).length,1);
});
test("CLI fails invalid input without starting a browser or creating jobs",async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"link-cli-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));assert.equal((await runLinkCli(["enqueue","file:///C:/secret"],{root,runtimeRoot:root})).ok,false);assert.equal((await runLinkCli(["unknown"],{root,runtimeRoot:root})).ok,false);
});

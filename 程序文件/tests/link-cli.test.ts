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

test("video parser stays opt-in, persists a local setting and can be turned off", async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"link-cli-parser-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const options={root,runtimeRoot:root};
 const before=await runLinkCli(["video-parser"],options);
 assert.equal(before.ok,true);assert.equal(before.enabled,false);
 const enabled=await runLinkCli(["video-parser","on"],options);
 assert.equal(enabled.ok,true);assert.equal(enabled.enabled,true);
 const persisted=await runLinkCli(["video-parser"],options);
 assert.equal(persisted.enabled,true);
 assert.equal(persisted.endpoint,"https://v.mtotech.com/api/resolve");
 const off=await runLinkCli(["video-parser","off"],options);
 assert.equal(off.enabled,false);
 assert.equal((await runLinkCli(["video-parser"],options)).enabled,false);
});

test("video parser configuration rejects credentials, non-HTTPS and private hosts", async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"link-cli-parser-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(const endpoint of ["http://example.com/parser","https://user:pass@example.com/parser","https://127.0.0.1/parser","https://localhost/parser","https://example.com/parser?token=placeholder"]){
  assert.equal((await runLinkCli(["video-parser","on",endpoint],{root,runtimeRoot:root})).ok,false);
 }
 const current=await runLinkCli(["video-parser"],{root,runtimeRoot:root});
 assert.equal(current.ok,true);assert.equal(current.enabled,false);
});

test("parser credentials are read only for their exact configured service and never appear in CLI output", async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"link-cli-parser-auth-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const options={root,runtimeRoot:root};
 await runLinkCli(["video-parser","on","https://sph.litao.workers.dev/api/fetch_video_profile"],options);
 await fs.writeFile(path.join(root,".content-parser-auth.json"),JSON.stringify({schemaVersion:1,endpoint:"https://sph.litao.workers.dev/api/fetch_video_profile",credential:"PLACEHOLDER_SERVICE_CREDENTIAL"}));
 const query=await runLinkCli(["video-parser"],options);
 assert.equal(query.credentialConfigured,true);assert.doesNotMatch(JSON.stringify(query),/PLACEHOLDER_SERVICE_CREDENTIAL/);
 await runLinkCli(["video-parser","on","https://example.com/parser"],options);
 assert.equal((await runLinkCli(["video-parser"],options)).credentialConfigured,false);
});

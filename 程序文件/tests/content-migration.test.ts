import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { migrateReadableLibrary } from "../src/content-migration.js";
import { contentIdentity,findContent,readContent,fileHash } from "../src/content-library.js";
import { withContentMaintenance } from "../src/content-jobs.js";
import type { ContentManifest } from "../src/content-types.js";

async function fixture(t:any){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"readable-migration-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const input={platform:"bilibili" as const,nativeId:"BVfixture",canonicalUrl:"https://www.bilibili.com/video/BVfixture"};const id=contentIdentity(input),directory=path.join(root,"items",id);
 await fs.mkdir(path.join(directory,"hash-prefix"),{recursive:true});await fs.writeFile(path.join(directory,"hash-prefix","片名 (1).mp4"),"ORIGINAL VIDEO");await fs.writeFile(path.join(directory,"hash-prefix","asr.md"),"转写只出现一次");
 const body="# 中文测试资料\n[原片](hash-prefix/片名 (1).mp4)";
 const manifest:ContentManifest={...input,sourceUrl:input.canonicalUrl,title:"中文测试资料",capturedAt:"2026-09-06T00:00:00Z",kind:"video",markdown:body+"\n转写只出现一次",assets:[{id:"old-stable-video-id",role:"video",status:"saved",path:"hash-prefix/片名 (1).mp4",sha256:await fileHash(path.join(directory,"hash-prefix","片名 (1).mp4"))},{id:"old-stable-asr-id",role:"transcript",status:"saved",path:"hash-prefix/asr.md",provenance:"machine_asr"}],warnings:[],contentId:id,schemaVersion:1,status:"partial",aliases:[input.canonicalUrl],updatedAt:"2026-09-06T00:00:00Z",contentHash:"old",bodyFile:"body.md",markdownFile:"content.md",readingFile:"reading.html"};
 await fs.writeFile(path.join(directory,"content.json"),JSON.stringify(manifest));await fs.writeFile(path.join(directory,"body.md"),body);await fs.writeFile(path.join(directory,"content.md"),manifest.markdown);await fs.writeFile(path.join(directory,"reading.html"),"<p>old</p>");
 await fs.writeFile(path.join(directory,"unindexed-sidecar.json"),'{"keep":"original"}');
 return {root,directory,manifest};
}

test("existing downloads migrate with stable IDs, byte-identical video and usable links; rerun is a no-op",async t=>{
 const {root,directory,manifest}=await fixture(t);const result=await migrateReadableLibrary(root,{pdf:async()=>undefined});
 assert.equal(result.migrated,1);assert.equal(result.failed.length,0);
 const [item]=await findContent(root);assert.equal(item.contentId,manifest.contentId);assert.match(path.basename(item.directory),/中文测试资料/);assert.notEqual(item.directory,directory);
 const read=await readContent(root,manifest.contentId);if(!read.ok)assert.fail(read.reason);
 assert.deepEqual(read.manifest.assets.map(a=>a.id),manifest.assets.map(a=>a.id));assert.equal(read.manifest.assets[0].sha256,manifest.assets[0].sha256);
 assert.match(read.manifest.assets[0].path!,/视频/);assert.equal(read.manifest.assets[0].capturePath,manifest.assets[0].path);
 assert.equal((read.text.match(/转写只出现一次/g)||[]).length,1);
 assert.doesNotMatch(await fs.readFile(item.readingPath,"utf8"),/href="hash-prefix/);
 assert.equal(await fs.readFile(path.join(result.items[0].backupDirectory!,"unindexed-sidecar.json"),"utf8"),'{"keep":"original"}');
 assert.equal(await fs.stat(directory).then(()=>true,()=>false),false);
 const again=await migrateReadableLibrary(root,{pdf:async()=>undefined});assert.equal(again.migrated,0);assert.equal((await findContent(root)).length,1);
});

test("migration refuses to race an active worker and leaves original files alone",async t=>{
 const {root,directory}=await fixture(t);
 await withContentMaintenance(root,async()=>{await assert.rejects(migrateReadableLibrary(root,{pdf:async()=>undefined}),/任务正在运行/);});
 assert.equal(await fs.readFile(path.join(directory,"hash-prefix","片名 (1).mp4"),"utf8"),"ORIGINAL VIDEO");
});

test("PDF regeneration failure leaves old library readable and reports a recoverable migration failure",async t=>{
 const {root,directory,manifest}=await fixture(t);await fs.writeFile(path.join(directory,"reading.pdf"),"%PDF-old");manifest.assets.push({id:"reading-pdf",role:"pdf",status:"saved",path:"reading.pdf"});await fs.writeFile(path.join(directory,"content.json"),JSON.stringify(manifest));
 const result=await migrateReadableLibrary(root,{pdf:async()=>{throw new Error("PDF temporarily busy");}});
 assert.equal(result.migrated,0);assert.equal(result.failed.length,1);assert.equal(await fs.readFile(path.join(directory,"reading.pdf"),"utf8"),"%PDF-old");assert.equal((await findContent(root)).length,1);
});

test("a crash after publishing resumes the original-directory backup without duplicate items",async t=>{
 const {root,directory}=await fixture(t);const first=await migrateReadableLibrary(root,{pdf:async()=>undefined});
 const item=first.items[0],backupRoot=path.dirname(item.backupDirectory!),journal=path.join(backupRoot,"迁移记录.json");
 const record=JSON.parse(await fs.readFile(journal,"utf8"));
 assert.ok(path.resolve(directory).startsWith(path.resolve(root)+path.sep));assert.ok(path.resolve(item.backupDirectory!).startsWith(path.resolve(root)+path.sep));
 await fs.rename(item.backupDirectory!,directory);await fs.writeFile(journal,JSON.stringify({...record,state:"published"}));
 const resumed=await migrateReadableLibrary(root,{pdf:async()=>undefined});assert.equal(resumed.migrated,1);assert.equal(resumed.failed.length,0);
 assert.equal((await findContent(root)).length,1);assert.equal(await fs.stat(directory).then(()=>true,()=>false),false);
 assert.equal(JSON.parse(await fs.readFile(journal,"utf8")).state,"completed");
});

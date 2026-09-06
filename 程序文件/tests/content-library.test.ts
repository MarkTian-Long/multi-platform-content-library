import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contentIdentity, contentStatus, saveContent, findContent, readContent, exportContent, publicValue, contentFile, atomicJson } from "../src/content-library.js";
import type { CapturedContent } from "../src/content-types.js";

const record = (overrides: Partial<CapturedContent> = {}): CapturedContent => ({ platform:"xiaohongshu", nativeId:"note123", sourceUrl:"https://www.xiaohongshu.com/explore/note123?xsec_token=SECRET", canonicalUrl:"https://www.xiaohongshu.com/explore/note123", title:"中文资料", kind:"article", markdown:"# 正文\n独特检索词", capturedAt:"2026-09-06T12:00:00Z", assets:[], warnings:[], ...overrides });
async function fixture(t:any) { const root=await fs.mkdtemp(path.join(os.tmpdir(),"link-library-"));t.after(()=>fs.rm(root,{recursive:true,force:true})); const stage=path.join(root,"stage");await fs.mkdir(stage);return {root:path.join(root,"library"),stage}; }
test("identity is stable across share tokens and body revisions",()=>{
 assert.equal(contentIdentity(record()),contentIdentity(record({sourceUrl:"https://xhslink.com/abc",markdown:"新版"})));
});
test("durable save indexes text, uses local assets and generates safe offline reading",async t=>{
 const {root,stage}=await fixture(t); await fs.writeFile(path.join(stage,"a.png"),"original-image");
 const saved=await saveContent(root,record({markdown:'# 正文\n独特检索词<script>alert(1)</script>\n![图](https://image.example/a.png)',assets:[{id:"image-1",role:"image",status:"saved",path:"a.png",sourceUrl:"https://image.example/a.png",provenance:"original"}]}),stage);
 const found=await findContent(root,"独特检索词");assert.equal(found.length,1);
 const html=await fs.readFile(found[0].readingPath,"utf8");assert.doesNotMatch(html,/<script\b/i);assert.doesNotMatch(html,/SECRET/);assert.match(html,/Content-Security-Policy/);
 const read=await readContent(root,saved.contentId,0,40);assert.equal(read.ok,true); if(read.ok){assert.ok(read.text.length<=40);assert.equal(read.manifest.assets[0].sha256?.length,64);}
});
test("a failed retry preserves verified successful bytes and their status",async t=>{
 const {root,stage}=await fixture(t); await fs.writeFile(path.join(stage,"a.png"),"original-image");
 const first=await saveContent(root,record({assets:[{id:"image-1",role:"image",status:"saved",path:"a.png"}]}),stage);
 await saveContent(root,record({assets:[{id:"image-1",role:"image",status:"failed",reason:"网络失败"}]}),stage);
 const read=await readContent(root,first.contentId);assert.equal(read.ok,true);if(read.ok)assert.equal(read.manifest.assets[0].status,"saved");
});
test("asset traversal and symlink escape cannot read files outside the stage",async t=>{
 const {root,stage}=await fixture(t);await fs.writeFile(path.join(stage,"..","private.txt"),"secret");
 await assert.rejects(saveContent(root,record({assets:[{id:"bad",role:"source",status:"saved",path:"../private.txt"}]}),stage),/路径|目录/);
 assert.equal(await fs.stat(path.join(root,"items",contentIdentity(record()),"content.json")).then(()=>true,()=>false),false);
});
test("export omits tokens, raw source snapshots and private manifest URLs",async t=>{
 const {root,stage}=await fixture(t);await fs.writeFile(path.join(stage,"source.html"),"SECRET");
 const saved=await saveContent(root,record({assets:[{id:"raw",role:"source",status:"saved",path:"source.html"}]}),stage);
 const result=await exportContent(root,saved.contentId);const files=await fs.readdir(result.directory);
 assert.ok(!files.includes("source.html"));assert.doesNotMatch(await fs.readFile(path.join(result.directory,"content.json"),"utf8"),/SECRET/);
 assert.equal(publicValue({message:"失败 https://example.com/a?token=SECRET&xsec_token=SECRET",url:"https://a.com/?auth_key=SECRET"}).message.includes("SECRET"),false);
});
test("read rejects unbounded requests and exposes only contained regular files",async t=>{
 const {root,stage}=await fixture(t);const saved=await saveContent(root,record(),stage);
 const read=await readContent(root,saved.contentId,-1,99999999);assert.equal(read.ok,false);
 await assert.rejects(contentFile(root,saved.contentId,"../../private"),/路径|目录/);
});
test("a junction in items cannot redirect writes outside the library",async t=>{
 const {root,stage}=await fixture(t);const outside=path.join(stage,"outside");await fs.mkdir(outside);await fs.mkdir(root);
 await fs.symlink(outside,path.join(root,"items"),"junction");
 await assert.rejects(saveContent(root,record(),stage),/路径|目录/);assert.deepEqual(await fs.readdir(outside),[]);
});
test("saving a loaded manifest does not append transcripts again",async t=>{
 const {root,stage}=await fixture(t);await fs.writeFile(path.join(stage,"transcript.md"),"唯一一句转写");
 const first=await saveContent(root,record({assets:[{id:"t",role:"transcript",status:"saved",path:"transcript.md"}]}),stage);
 const second=await saveContent(root,first,path.join(root,"items",first.contentId));assert.equal(second.markdown,first.markdown);
});
test("modified retained files become explicit failures instead of disappearing",async t=>{
 const {root,stage}=await fixture(t);await fs.writeFile(path.join(stage,"a.png"),"original");
 const first=await saveContent(root,record({assets:[{id:"image",role:"image",status:"saved",path:"a.png"}]}),stage);
 await fs.writeFile(path.join(root,"items",first.contentId,"a.png"),"modified");const second=await saveContent(root,record(),stage);
 assert.equal(second.status,"partial");assert.equal(second.assets[0].status,"failed");
});
test("oversize text fails explicitly before saving an unreadable manifest",async t=>{
 const {root,stage}=await fixture(t);await assert.rejects(saveContent(root,record({markdown:"x".repeat(8*1024*1024)}),stage),/上限|过大/);
});
test("ASS and description text exports pass through the same redaction",async t=>{
 const {root,stage}=await fixture(t);await fs.writeFile(path.join(stage,"s.ass"),"Dialogue: token=EXPOSED");
 const first=await saveContent(root,record({assets:[{id:"s",role:"subtitle",status:"saved",path:"s.ass"}]}),stage);
 const result=await exportContent(root,first.contentId);assert.doesNotMatch(await fs.readFile(path.join(result.directory,"s.ass"),"utf8"),/EXPOSED/);
});
test("an omitted missing dependency keeps its actionable status",async t=>{const {root,stage}=await fixture(t);await saveContent(root,record({assets:[{id:"asr",role:"transcript",status:"missing_dependency",reason:"安装模型"}]}),stage);const second=await saveContent(root,record(),stage);assert.equal(second.assets[0].status,"missing_dependency");assert.equal(second.assets[0].reason,"安装模型");});

test("unknown per-part duration or discussion coverage cannot claim comprehensive completion",()=>{
 const video=record({kind:"video",parts:[{id:"p1",title:"P1",status:"saved"}],assets:(["video","audio","transcript","frame","ocr"] as const).map(role=>({id:role,role,status:"saved",partId:"p1"}))});
 assert.equal(contentStatus(video),"completed");
 assert.equal(contentStatus({...video,coverage:{"part:p1:duration":"unknown: missing metadata duration"}}),"partial");
 assert.equal(contentStatus({...video,coverage:{danmaku:"unknown"}}),"partial");
});

test("transient Windows rename contention retries without deleting the last good file",async t=>{
 const {stage}=await fixture(t),file=path.join(stage,"queue.json");await atomicJson(file,{version:0});
 const rename=fs.rename.bind(fs);let failures=0;
 t.mock.method(fs,"rename",async(source:any,destination:any)=>{if(destination===file&&failures++<2){assert.equal(JSON.parse(await fs.readFile(file,"utf8")).version,0);throw Object.assign(new Error("brief reader lock"),{code:"EPERM"});}return rename(source,destination);});
 await atomicJson(file,{version:1});assert.equal(JSON.parse(await fs.readFile(file,"utf8")).version,1);assert.equal(failures,3);
});

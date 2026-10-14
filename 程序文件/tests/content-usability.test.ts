import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import { contentStatus,saveContent,containedFile,fileHash,contentDirectory,findContent } from "../src/content-library.js";
import { enrichContent } from "../src/content-enrichment.js";
import { parseProcessingMode,normalizedProgress } from "../src/content-processing.js";
import { readTranscriptEdition,saveTranscriptEdition,replaceTranscriptTerms } from "../src/content-transcript-edit.js";
import { runLinkCli } from "../src/link-cli.js";
import {exportContentZip} from "../src/content-organization.js";
import type { CapturedContent } from "../src/content-types.js";

const base=():CapturedContent=>({platform:"web",nativeId:"upgrade",sourceUrl:"https://example.com/upgrade",canonicalUrl:"https://example.com/upgrade",title:"校订样本",capturedAt:"2026-10-14T00:00:00Z",kind:"video",markdown:"简介",warnings:[],assets:[{id:"video",role:"video",status:"saved",path:"original.mp4",provenance:"original"}]});
test("chosen modes require only their requested derivatives and legacy defaults stay full",()=>{
  const record=base();assert.equal(contentStatus(record),"partial");record.processingMode="original";assert.equal(contentStatus(record),"completed");record.processingMode="transcribe";assert.equal(contentStatus(record),"partial");record.assets.push({id:"text",role:"transcript",status:"saved",provenance:"machine_asr"});assert.equal(contentStatus(record),"completed");record.assets.push({id:"frames",role:"frame",status:"missing_dependency",provenance:"sampled_frame"});assert.equal(contentStatus(record),"completed");record.processingMode="full";assert.equal(contentStatus(record),"partial");
});
test("original mode does not invoke local tool work or create output trees",async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"usability-original-"));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const record=base(),result=await enrichContent(record,{runtimeRoot:directory,directory,processing:"original"});assert.deepEqual(result.assets,record.assets);assert.equal(result.processingMode,"original");assert.deepEqual(await fs.readdir(directory),[]);
});
test("phase progress rejects unknown or invalid denominators and choices are validated",()=>{
  assert.equal(parseProcessingMode(undefined),"full");assert.throws(()=>parseProcessingMode("turbo"));assert.deepEqual(normalizedProgress({phase:"ASR",completed:2,total:0}),{phase:"ASR"});assert.deepEqual(normalizedProgress({phase:"OCR",completed:2,total:4,unit:"张"}),{phase:"OCR",completed:2,total:4,unit:"张"});assert.deepEqual(normalizedProgress({phase:"OCR",completed:5,total:4}),{phase:"OCR"});
});
async function transcriptFixture(t:test.TestContext){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"usability-edit-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));const stage=path.join(root,"stage");await fs.mkdir(stage);await fs.writeFile(path.join(stage,"original.mp4"),"original-media-bytes");await fs.writeFile(path.join(stage,"asr.md"),"# 机器稿\n\n[00:00.000 - 00:01.000] 萨斯是软件服务\n");
  const record=base();record.assets.push({id:"transcript",role:"transcript",status:"saved",path:"asr.md",provenance:"machine_asr"});record.processingMode="transcribe";const manifest=await saveContent(root,record,stage);return {root,manifest};
}
test("user editions preserve originals, detect stale saves, appear in search and keep revisions",async t=>{
  const {root,manifest}=await transcriptFixture(t),directory=await contentDirectory(root,manifest.contentId),original=manifest.assets.find(a=>a.id==="transcript")!,media=manifest.assets.find(a=>a.id==="video")!;
  const read=await readTranscriptEdition(root,manifest.contentId);const preview=replaceTranscriptTerms(read.text,[{from:"萨斯",to:"SaaS"}]);assert.equal(preview.replacements,1);
  const saved=await saveTranscriptEdition(root,manifest.contentId,{sourceAssetId:read.sourceAssetId,expectedSha256:read.expectedSha256,text:preview.text});assert.equal(saved.unchanged,false);assert.equal(await fileHash(await containedFile(directory,original.path!)),original.sha256);assert.equal(await fileHash(await containedFile(directory,media.path!)),media.sha256);
  const reread=await readTranscriptEdition(root,manifest.contentId);assert.equal(reread.edited,true);assert.match(reread.originalText,/萨斯/);assert.match(reread.text,/SaaS/);assert.notEqual(reread.expectedSha256,read.expectedSha256);
  await assert.rejects(saveTranscriptEdition(root,manifest.contentId,{sourceAssetId:read.sourceAssetId,expectedSha256:read.expectedSha256,text:"过期改写"}),/另一个窗口/);
  assert.equal((await findContent(root,"SaaS")).length,1);assert.match((await findContent(root))[0].transcriptPath??"",/校订文字稿/);
  await saveTranscriptEdition(root,manifest.contentId,{sourceAssetId:read.sourceAssetId,expectedSha256:reread.expectedSha256,text:reread.text+"\n校订第二版"});assert.equal((await fs.readdir(path.join(directory,"校订历史"))).filter(name=>name.endsWith(".json")).length,2);
});
test("rebuilt source transcripts allow a new edition and retain the old source and user bytes",async t=>{
  const {root,manifest}=await transcriptFixture(t),directory=await contentDirectory(root,manifest.contentId),source=manifest.assets.find(a=>a.id==="transcript")!,read=await readTranscriptEdition(root,manifest.contentId),editedText=read.text.replace("萨斯","SaaS");
  const first=await saveTranscriptEdition(root,manifest.contentId,{sourceAssetId:read.sourceAssetId,expectedSha256:read.expectedSha256,text:editedText});
  const stage=path.join(root,"rebuild");await fs.mkdir(stage);await fs.writeFile(path.join(stage,"new.md"),"# 更准的新机器稿\n\n新的来源 B");
  const current=JSON.parse(await fs.readFile(path.join(directory,"content.json"),"utf8"));const replacement={...source,path:"new.md",capturePath:"new.md",sha256:undefined,bytes:undefined};const {schemaVersion,...record}=current;record.markdown="简介";record.assets=[replacement];await saveContent(root,record,stage);
  const next=await readTranscriptEdition(root,manifest.contentId,source.id);assert.equal(next.staleEdition,true);assert.equal(next.edited,false);assert.match(next.text,/新的来源 B/);assert.equal(next.staleText,editedText);assert.equal(next.staleOriginalText,read.originalText);
  await saveTranscriptEdition(root,manifest.contentId,{sourceAssetId:next.sourceAssetId,expectedSha256:next.expectedSha256,text:next.text+"\n新校订 B"});assert.equal((await readTranscriptEdition(root,manifest.contentId)).staleEdition,false);assert.match((await readTranscriptEdition(root,manifest.contentId)).text,/新校订 B/);assert.equal(await fs.readFile(path.join(directory,"校订历史",`${first.version}.md`),"utf8"),editedText);
});
test("literal terms never become regular expressions and empty edits are refused",()=>{
  assert.equal(replaceTranscriptTerms("a.b a?b",[{from:"a.b",to:"X"}]).text,"X a?b");assert.throws(()=>replaceTranscriptTerms("文字",[{from:"",to:"x"}]));assert.throws(()=>replaceTranscriptTerms("文字",[{from:"文字",to:""}]));
  assert.equal(replaceTranscriptTerms("a",[{from:"a",to:"$&"}]).text,"$&");
  assert.throws(()=>replaceTranscriptTerms("x".repeat(16384),[{from:"x",to:"x".repeat(200)},{from:"x".repeat(200),to:"x"}]),/本轮.*上限/);
});
test("PDF editions update after corrections and a failed renderer never advertises stale PDF as current",async t=>{
  const {root,manifest}=await transcriptFixture(t),directory=await contentDirectory(root,manifest.contentId);await fs.writeFile(path.join(directory,"阅读.pdf"),"%PDF-1.4 previous");manifest.assets.push({id:"reading-pdf",role:"pdf",status:"saved",path:"阅读.pdf",provenance:"generated"});await saveContent(root,manifest,directory);
  const read=await readTranscriptEdition(root,manifest.contentId),draft={sourceAssetId:read.sourceAssetId,expectedSha256:read.expectedSha256,text:read.text+"\n第一版校订"};
  const updated=await saveTranscriptEdition(root,manifest.contentId,draft,{pdf:async dir=>{assert.match(await fs.readFile(path.join(dir,"阅读.html"),"utf8"),/第一版校订/);await fs.writeFile(path.join(dir,"阅读.pdf"),"%PDF-1.4 current");return "阅读.pdf";}});assert.equal(updated.pdfStatus,"updated");assert.ok((await findContent(root))[0].pdfPath);
  const next=await readTranscriptEdition(root,manifest.contentId);const failed=await saveTranscriptEdition(root,manifest.contentId,{...draft,expectedSha256:next.expectedSha256,text:next.text+"\n第二版校订"},{pdf:async()=>{throw new Error("renderer unavailable");}});assert.equal(failed.pdfStatus,"stale");assert.equal((await findContent(root))[0].pdfPath,undefined);assert.match((await readTranscriptEdition(root,manifest.contentId)).text,/第二版校订/);assert.equal(await fs.readFile(path.join(directory,"阅读.pdf"),"utf8"),"%PDF-1.4 current");
});
test("transcribe video does not attempt frames/OCR, while original-image text failures remain visible",async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"usability-options-"));t.after(()=>fs.rm(directory,{recursive:true,force:true}));await fs.writeFile(path.join(directory,"original.mp4"),"nonempty fixture media");const result=await enrichContent(base(),{runtimeRoot:path.join(directory,"empty-runtime"),directory,processing:"transcribe"});assert.equal(result.assets.some(a=>["frame","ocr"].includes(a.role)),false);assert.equal(result.assets.some(a=>a.role==="transcript"&&a.status!=="saved"),true);
  const gallery=base();gallery.kind="gallery";gallery.processingMode="transcribe";gallery.assets=[{id:"image",role:"image",status:"saved",provenance:"original"},{id:"ocr",role:"ocr",status:"missing_dependency",provenance:"machine_ocr",reason:"缺少识别语言"}];assert.equal(contentStatus(gallery),"partial");gallery.processingMode="original";assert.equal(contentStatus(gallery),"completed");
});
test("OCR text can be opened and corrected while preserving the machine image text",async t=>{
  const {root,manifest}=await transcriptFixture(t),directory=await contentDirectory(root,manifest.contentId),source=manifest.assets.find(a=>a.id==="transcript")!;source.role="ocr";source.provenance="machine_ocr";manifest.kind="gallery";manifest.assets.push({id:"image",role:"image",status:"saved",path:manifest.assets[0].path,provenance:"original"});await fs.writeFile(path.join(directory,"content.json"),JSON.stringify(manifest));
  assert.ok((await findContent(root))[0].transcriptPath);const read=await readTranscriptEdition(root,manifest.contentId);assert.equal(read.sourceRole,"ocr");await saveTranscriptEdition(root,manifest.contentId,{sourceAssetId:read.sourceAssetId,expectedSha256:read.expectedSha256,text:read.text.replace("萨斯","SaaS")});assert.equal(await fileHash(await containedFile(directory,source.path!)),source.sha256);assert.match((await readTranscriptEdition(root,manifest.contentId)).text,/SaaS/);
});
test("ZIP rejects a same-size externally altered asset rather than shipping bytes with stale provenance",async t=>{
  const {root,manifest}=await transcriptFixture(t),directory=await contentDirectory(root,manifest.contentId),video=manifest.assets.find(a=>a.id==="video")!,file=await containedFile(directory,video.path!),tampered=await fs.readFile(file);tampered[0]^=1;await fs.writeFile(file,tampered);
  await assert.rejects(exportContentZip(root,manifest.contentId),/变化|完整性|校验/);assert.deepEqual(await fs.readdir(path.join(root,"exports")).catch(()=>[]),[]);
});
test("CLI records selected processing modes and refuses invalid mode before enqueuing",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"usability-cli-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const added=await runLinkCli(["enqueue","--processing","original","https://example.com/test"],{root,runtimeRoot:root});assert.equal(added.ok,true);assert.equal((added.jobs as Array<{input:{processing?:string}}>)[0].input.processing,"original");const rejected=await runLinkCli(["enqueue","--processing","turbo","https://example.com/other"],{root,runtimeRoot:root});assert.equal(rejected.ok,false);
});
test("real window completes transcript editing, organization, ZIP and reversible history flows",{skip:process.platform!=="win32"},async t=>{
  const {root,manifest}=await transcriptFixture(t),directory=await contentDirectory(root,manifest.contentId);
  manifest.assets.push({id:"frames-missing",role:"frame",status:"missing_dependency",provenance:"sampled_frame",reason:"没有工具"});await fs.writeFile(path.join(directory,"content.json"),JSON.stringify(manifest));
  const run=spawnSync("powershell.exe",["-NoProfile","-STA","-ExecutionPolicy","Bypass","-File",path.resolve("tests/link-usability-harness.ps1"),"-ProjectRoot",path.resolve(".."),"-ContentRoot",root,"-ContentId",manifest.contentId],{encoding:"utf8",timeout:90000,windowsHide:true});assert.equal(run.status,0,`${run.stdout}\n${run.stderr}`);assert.equal(JSON.parse(run.stdout.trim()).ok,true);
  assert.match((await readTranscriptEdition(root,manifest.contentId)).text,/SaaS/);
  const original=manifest.assets.find(a=>a.id==="transcript")!;assert.equal(await fileHash(await containedFile(directory,original.path!)),original.sha256);
});

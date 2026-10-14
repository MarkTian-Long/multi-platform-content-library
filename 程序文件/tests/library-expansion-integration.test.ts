import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enrichContent } from "../src/content-enrichment.js";
import { contentStatus,saveContent,contentDirectory,fileHash,readContent,exportContent } from "../src/content-library.js";
import { enqueueInputs,updateJob,runJobs,retryJob } from "../src/content-jobs.js";
import { runLinkCli } from "../src/link-cli.js";
import { localFileInput } from "../src/content-local-queue.js";
import { processContentJob } from "../src/content-service.js";
import { inspectContentStorage,reclaimContentStaging } from "../src/content-storage.js";
import type { CapturedContent } from "../src/content-types.js";

test("an imported audio file requests local ASR without generating duplicate media",async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"library-audio-import-"));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  await fs.writeFile(path.join(directory,"input.mp3"),"bounded-fixture");
  const record:CapturedContent={platform:"local",nativeId:"fixture",sourceUrl:"local-import:fixture",canonicalUrl:"local-import:fixture",title:"访谈",kind:"audio",capturedAt:new Date().toISOString(),markdown:"",warnings:[],assets:[{id:"original-audio",role:"audio",status:"saved",path:"input.mp3",provenance:"original"}]};
  const output=await enrichContent(record,{runtimeRoot:directory,directory});
  assert.equal(output.assets.find(asset=>asset.id==="original-audio")?.status,"saved");
  assert.equal(output.assets.filter(asset=>asset.role==="audio").length,1);
  assert.equal(output.assets.filter(asset=>["video","frame","ocr"].includes(asset.role)).length,0);
  assert.ok(output.assets.some(asset=>asset.role==="transcript"&&asset.provenance==="machine_asr"&&asset.status==="missing_dependency"));
  assert.equal(contentStatus(output),"partial");
  assert.equal(await fs.readFile(path.join(directory,"input.mp3"),"utf8"),"bounded-fixture");
});

test("saved audio alone is readable but completion requires a saved transcript",()=>{
  const record:CapturedContent={platform:"local",sourceUrl:"local-import:fixture",canonicalUrl:"local-import:fixture",title:"录音",kind:"audio",capturedAt:new Date().toISOString(),markdown:"",warnings:[],assets:[{id:"audio",role:"audio",status:"saved",path:"original.mp3"}]};
  assert.equal(contentStatus(record),"partial");
  assert.equal(contentStatus({...record,assets:[...record.assets,{id:"transcript",role:"transcript",status:"saved",path:"transcript.md"}]}),"completed");
  assert.equal(contentStatus({...record,assets:[]}),"failed");
});

test("storage CLI requires a current plan and reports remaining candidates after reclaim",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"library-storage-cli-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const input={platform:"web" as const,url:"https://example.com/saved",canonicalUrl:"https://example.com/saved"};
  const [job]=await enqueueInputs(root,[input]),stage=path.join(root,"staging",job.id);
  await fs.mkdir(stage,{recursive:true});await fs.writeFile(path.join(stage,"original.txt"),"已保存的原始文件");
  const manifest=await saveContent(root,{platform:"web",sourceUrl:input.url,canonicalUrl:input.canonicalUrl,title:"工作副本",kind:"article",capturedAt:new Date().toISOString(),markdown:"正文",warnings:[],assets:[{id:"original",role:"source",path:"original.txt",status:"saved",provenance:"original"}]},stage);
  await updateJob(root,job.id,{state:"completed",contentId:manifest.contentId});
  const inspection=await runLinkCli(["storage"],{root}),plan=inspection.plan as {planId:string;reclaimableFiles:number};
  assert.equal(plan.reclaimableFiles,1);
  const stale=await runLinkCli(["storage","--apply","stale"],{root});
  assert.equal(stale.ok,false);assert.ok(await fs.stat(path.join(stage,"original.txt")));
  const applied=await runLinkCli(["storage","--apply",plan.planId],{root});
  assert.equal(applied.ok,true);assert.equal(applied.reclaimedFiles,1);
  assert.equal((applied.plan as typeof plan).reclaimableFiles,0);
  const directory=await contentDirectory(root,manifest.contentId),asset=manifest.assets[0];
  assert.equal(await fileHash(path.join(directory,asset.path!)),asset.sha256);
});

test("local identities survive renaming, respect format, and hide private queue paths",async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"local-identity-")),root=path.join(directory,"library");
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const first=path.join(directory,"中文笔记.md"),renamed=path.join(directory,"更名.markdown"),plain=path.join(directory,"plain.txt");
  for(const file of [first,renamed,plain])await fs.writeFile(file,"# 保留原意\n同一份字节\n");
  const a=await localFileInput(first),b=await localFileInput(renamed),c=await localFileInput(plain);
  assert.equal(a.nativeId,b.nativeId);assert.notEqual(a.nativeId,c.nativeId);
  const queued=await runLinkCli(["import",first,renamed],{root});
  assert.equal(queued.ok,true);assert.equal(queued.addedCount,1);assert.equal(queued.existingCount,1);
  assert.equal((queued.jobs as Array<{title:string}>)[0].title,"中文笔记.md");
  assert.ok(!JSON.stringify(queued).includes("localPath"));
  const internal=JSON.parse(await fs.readFile(path.join(root,"queue.json"),"utf8"));
  assert.equal(internal.jobs[0].input.localPath,renamed);
});

test("worker imports the selected text and rejects bytes changed since queue inspection",async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"local-worker-")),root=path.join(directory,"library");
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const source=path.join(directory,"本地手记.md"),text="# 本地手记\n\n原件、正文和保存路径应一致。\n";
  await fs.writeFile(source,text);const input=await localFileInput(source),[job]=await enqueueInputs(root,[input]);
  const outcome=await processContentJob(process.cwd(),root,job,new AbortController().signal,{pdf:async()=>undefined});
  assert.equal(outcome.state,"completed");
  const read=await readContent(root,outcome.contentId!);assert.ok(read.ok);
  if(read.ok){
    assert.equal(read.manifest.nativeId,input.nativeId);
    const saved=await contentDirectory(root,outcome.contentId!),asset=read.manifest.assets.find(item=>item.provenance==="original")!;
    assert.equal(await fs.readFile(path.join(saved,read.manifest.bodyFile!),"utf8"),text);
    assert.equal(await fileHash(path.join(saved,asset.path!)),asset.sha256);
    const html=await fs.readFile(path.join(saved,read.manifest.readingFile),"utf8");
    assert.ok(html.includes("打开保存的原文件"));assert.ok(!html.includes('href="local://'));
    assert.ok(!html.includes(source));
  }
  const changed=path.join(directory,"变化.txt");await fs.writeFile(changed,"原来内容");
  const changedInput=await localFileInput(changed),[changedJob]=await enqueueInputs(path.join(directory,"changed-library"),[changedInput]);
  await fs.writeFile(changed,"后来的不同内容");
  await assert.rejects(processContentJob(process.cwd(),path.join(directory,"changed-library"),changedJob,new AbortController().signal,{pdf:async()=>undefined}),/源文件字节或格式已变化/);
  assert.equal(await fs.readdir(path.join(directory,"changed-library","items")).then(items=>items.length,()=>0),0);
  assert.equal(await fs.readFile(source,"utf8"),text);
});

test("local text export retains the exact original, and PDF retry survives source relocation and staging reclamation",async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"local-export-recovery-")),root=path.join(directory,"library"),source=path.join(directory,"original.html");
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const original="<html><title>本地原件</title><body><main><p>正文，保留原始字节。</p></main></body></html>";
  await fs.writeFile(source,original);const input=await localFileInput(source);await enqueueInputs(root,[input]);
  const first=await runJobs(root,(job,signal)=>processContentJob(process.cwd(),root,job,signal,{enrich:async record=>record,pdf:async()=>{throw new Error("临时 PDF 失败");}}));
  assert.equal(first[0].state,"partial");
  const formal=await readContent(root,first[0].contentId!);assert.ok(formal.ok);
  const exported=await exportContent(root,first[0].contentId!),exportManifest=JSON.parse(await fs.readFile(path.join(exported.directory,"content.json"),"utf8"));
  const exportedOriginal=exportManifest.assets.find((asset:{provenance?:string})=>asset.provenance==="original");
  assert.ok(exportedOriginal,"export must retain original source assets");
  assert.equal(await fs.readFile(path.join(exported.directory,exportedOriginal.path),"utf8"),original);
  const plan=await inspectContentStorage(root),cleaned=await reclaimContentStaging(root,{jobIds:plan.jobIds,expectedPlanId:plan.planId});
  assert.equal(cleaned.reclaimedFiles,1);
  await fs.rename(source,path.join(directory,"relocated.html"));await retryJob(root,first[0].id);
  let pdfCalled=false;
  const second=await runJobs(root,(job,signal)=>processContentJob(process.cwd(),root,job,signal,{enrich:async record=>record,pdf:async target=>{pdfCalled=true;await fs.writeFile(path.join(target,"阅读.pdf"),"%PDF-1.4\nlocal-fixture");return "阅读.pdf";}}));
  assert.equal(pdfCalled,true);assert.equal(second[0].state,"completed");
  assert.equal(second[0].contentId,first[0].contentId);
});

test("missing local source paths stay private in public errors and persisted retry failures",async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"local-private-errors-")),privateDirectory=path.join(directory,"private-selection"),root=path.join(directory,"library");
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  await fs.mkdir(privateDirectory);const source=path.join(privateDirectory,"note.txt");await fs.writeFile(source,"正文");
  const input=await localFileInput(source);await enqueueInputs(root,[input]);await fs.unlink(source);
  const result=await runJobs(root,(job,signal)=>processContentJob(process.cwd(),root,job,signal,{pdf:async()=>undefined}));
  assert.equal(result[0].state,"failed");assert.ok(!result[0].message.includes(privateDirectory));
  const cli=await runLinkCli(["import",source],{root});
  assert.equal(cli.ok,false);assert.ok(!JSON.stringify(cli).includes(privateDirectory.replaceAll("\\","\\\\")));
  const secondSource=path.join(privateDirectory,"saved-before-error.txt");await fs.writeFile(secondSource,"另一份原始正文");
  const secondInput=await localFileInput(secondSource);await enqueueInputs(root,[secondInput]);
  const later=await runJobs(root,(job,signal)=>processContentJob(process.cwd(),root,job,signal,{enrich:async()=>{throw Object.assign(new Error(`EPERM: open '${secondSource}'`),{code:"EPERM"});},pdf:async()=>undefined}));
  const failed=later.find(job=>job.input.nativeId===secondInput.nativeId)!;assert.equal(failed.state,"failed");assert.ok(failed.contentId);
  const saved=await contentDirectory(root,failed.contentId!),persisted=await fs.readFile(path.join(saved,"content.json"),"utf8");
  assert.ok(!persisted.includes(privateDirectory.replaceAll("\\","\\\\")));
  const exported=await exportContent(root,failed.contentId!),exportedManifest=await fs.readFile(path.join(exported.directory,"content.json"),"utf8");
  assert.ok(!exportedManifest.includes(privateDirectory.replaceAll("\\","\\\\")));
  assert.equal(await fs.readFile(path.join(saved,"原始正文.md"),"utf8"),"另一份原始正文");
});

test("an invalid configured library path returns the normal CLI error contract",async()=>{
  const previous=process.env.CONTENT_LIBRARY_ROOT;process.env.CONTENT_LIBRARY_ROOT="relative-library";
  try{const result=await runLinkCli(["jobs"]);assert.equal(result.ok,false);assert.match(result.message,/绝对目录/);}
  finally{if(previous===undefined)delete process.env.CONTENT_LIBRARY_ROOT;else process.env.CONTENT_LIBRARY_ROOT=previous;}
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {createHash} from "node:crypto";
import {enrichContent} from "../src/content-enrichment.js";
import {fileHash} from "../src/content-library.js";
import type {CapturedContent,ContentAsset,ContentContext} from "../src/content-types.js";

async function fixture(t:any,complete=true){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"review-asr-reuse-"));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const id="video-1",base=id+"-"+createHash("sha256").update(id).digest("hex").slice(0,12);await fs.mkdir(path.join(directory,"derived","transcripts"),{recursive:true});
  await fs.writeFile(path.join(directory,"video.mp4"),"same original video bytes");
  const md=`derived/transcripts/${base}.asr.md`,json=`derived/transcripts/${base}.asr.json`,srt=`derived/transcripts/${base}.asr.srt`;
  const data={language:"zh",engine:"faster-whisper",engineVersion:"local-test",model:"faster-whisper-small",computeType:"int8",requestedComputeType:"int8",hotwords:"SaaS API",durationMs:2000,segments:[{startMs:0,endMs:2000,text:"原始识别词"}]};
  await fs.writeFile(path.join(directory,md),complete?"# 机器语音转写\n\n语言：zh\n工具：faster-whisper；模型：faster-whisper-small\n\n- [00:00:00.000 – 00:00:02.000] 原始识别词\n":"# 机器语音转写\n\n语言：zh\n");
  if(complete){await fs.writeFile(path.join(directory,json),JSON.stringify(data));await fs.writeFile(path.join(directory,srt),"1\n00:00:00,000 --> 00:00:02,000\n原始识别词\n");}
  const source:ContentAsset={id,role:"video",status:"saved",path:"video.mp4",sha256:await fileHash(path.join(directory,"video.mp4")),provenance:"original"};
  const record:CapturedContent={platform:"web",sourceUrl:"https://example.com/asr",canonicalUrl:"https://example.com/asr",kind:"video",title:"ASR evidence",capturedAt:"2026-10-14T00:00:00Z",markdown:"原始正文",warnings:[],assets:[source]};
  const context:ContentContext={directory,runtimeRoot:directory};
  if(complete){const outputs:ContentAsset[]=[{id:`transcript-asr-${base}`,role:"transcript",status:"saved",path:md,provenance:"machine_asr"},{id:`asr-data-${base}`,role:"source",status:"saved",path:json,provenance:"machine_asr"},{id:`asr-subtitle-${base}`,role:"subtitle",status:"saved",path:srt,provenance:"machine_asr"}];for(const a of outputs){a.sha256=await fileHash(path.join(directory,a.path!));a.bytes=(await fs.stat(path.join(directory,a.path!))).size;a.label=id;}context.existing={...record,assets:[source,...outputs]};}
  return {directory,record,context,source,md,json,srt,data};
}
test("ASR reuse rejects a nonempty heading without successful output evidence",async t=>{const f=await fixture(t,false);const r=await enrichContent(f.record,f.context);assert.equal(r.assets.some(a=>a.provenance==="machine_asr"&&a.status==="saved"),false);});
test("verified small ASR is reused with all three artifacts and language instead of the tiny default",async t=>{const f=await fixture(t);const r=await enrichContent(f.record,f.context),asr=r.assets.filter(a=>a.provenance==="machine_asr");assert.equal(asr.length,3);assert.ok(asr.every(a=>a.status==="saved"&&a.language==="zh"));assert.deepEqual(new Set(asr.map(a=>a.role)),new Set(["transcript","source","subtitle"]));assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory,f.json),"utf8")),f.data);});
test("ASR reuse rejects inconsistent JSON SRT and Markdown even when all files have hashes",async t=>{const f=await fixture(t);await fs.writeFile(path.join(f.directory,f.srt),"1\n00:00:00,000 --> 00:00:02,000\nDIFFERENT_WORDS\n");f.context.existing!.assets.find(a=>a.role==="subtitle")!.sha256=await fileHash(path.join(f.directory,f.srt));const r=await enrichContent(f.record,f.context);assert.equal(r.assets.some(a=>a.provenance==="machine_asr"&&a.status==="saved"),false);});
test("ASR reuse rejects a source change while retaining the old files",async t=>{const f=await fixture(t);await fs.writeFile(path.join(f.directory,"video.mp4"),"different original");const r=await enrichContent(f.record,f.context);assert.equal(r.assets.some(a=>a.provenance==="machine_asr"&&a.status==="saved"),false);assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory,f.json),"utf8")),f.data);});
test("an explicit new ASR model can request recalculation while an unset model preserves existing quality",async t=>{const f=await fixture(t),old=process.env.CONTENT_ASR_MODEL;process.env.CONTENT_ASR_MODEL=path.join(f.directory,"explicit-new-model");try{const r=await enrichContent(f.record,f.context);assert.equal(r.assets.some(a=>a.provenance==="machine_asr"&&a.status==="saved"),false);}finally{if(old===undefined)delete process.env.CONTENT_ASR_MODEL;else process.env.CONTENT_ASR_MODEL=old;}});

test("an explicit model directory with the same basename cannot reuse weights proved only by name",async t=>{const f=await fixture(t),old=process.env.CONTENT_ASR_MODEL;process.env.CONTENT_ASR_MODEL=path.join(f.directory,"different-weights","faster-whisper-small");try{const r=await enrichContent(f.record,f.context);assert.equal(r.assets.some(a=>a.provenance==="machine_asr"&&a.status==="saved"),false);assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory,f.json),"utf8")),f.data);}finally{if(old===undefined)delete process.env.CONTENT_ASR_MODEL;else process.env.CONTENT_ASR_MODEL=old;}});
test("a saved machine ASR subtitle is never relabelled as a platform subtitle on retry",async t=>{const f=await fixture(t);f.record.assets=structuredClone(f.context.existing!.assets);const r=await enrichContent(f.record,f.context);assert.equal(r.assets.some(a=>a.provenance==="platform_subtitle"),false);});

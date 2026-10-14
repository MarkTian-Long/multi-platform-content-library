import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { processContentJob,listSavedContent } from "../src/content-service.js";
import { enqueueInputs,getJobs } from "../src/content-jobs.js";
import { findContent,readContent,saveContent,contentIdentity } from "../src/content-library.js";
import type { CapturedContent } from "../src/content-types.js";
import { saveArticle } from "../src/article-library.js";
import { promises as dns } from "node:dns";
import { chromium } from "playwright-core";
async function fixture(t:any){const root=await fs.mkdtemp(path.join(os.tmpdir(),"link-service-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));const [job]=await enqueueInputs(root,[{platform:"web",url:"https://example.com/article",canonicalUrl:"https://example.com/article"}]);return {root,job};}
const base:CapturedContent={platform:"web",sourceUrl:"https://example.com/article",canonicalUrl:"https://example.com/article",title:"示例",kind:"article",capturedAt:"2026-09-06T00:00:00Z",markdown:"原始文字",assets:[],warnings:[]};

test("retrying a verified Douyin original normalizes legacy unsupported extras without acquisition",async t=>{
 const {root}=await fixture(t),id="6961737553342991651",url=`https://www.douyin.com/video/${id}`;
 const input={platform:"douyin" as const,nativeId:id,url,canonicalUrl:url,processing:"original" as const};
 const job=(await enqueueInputs(root,[input])).find(item=>item.platform==="douyin")!;
 const seed=path.join(root,"seed-douyin");await fs.mkdir(seed);await fs.writeFile(path.join(seed,"original.mp4"),"previously-verified-douyin-video");
 const record:CapturedContent={...input,sourceUrl:url,title:"已保存抖音作品",capturedAt:base.capturedAt,kind:"video",markdown:"原始作品说明",warnings:[],coverage:{body:"saved: exact-work original description",media:"saved: 1 verified original video",comments:"not_attempted",subtitles:"not_attempted"},parts:[{id,title:"已保存抖音作品",status:"saved",durationSeconds:19}],assets:[{id:"video/001",role:"video",status:"saved",path:"original.mp4",partId:id,provenance:"original"}]};
 const previous=await saveContent(root,record,seed);let requests=0;
 t.mock.method(globalThis,"fetch",async()=>{requests++;throw new Error("no acquisition during verified original reuse");});
 t.mock.method(chromium,"launchPersistentContext",async()=>{throw new Error("no browser during verified original reuse");});
 const result=await processContentJob(root,root,job,new AbortController().signal,{enrich:async r=>r});
 assert.equal(requests,0);assert.equal(result.state,"completed");
 const saved=(await findContent(root)).find(item=>item.contentId===previous.contentId)!;
 const manifest=JSON.parse(await fs.readFile(path.join(saved.directory,"content.json"),"utf8"));
 assert.equal(manifest.assets.find((asset:any)=>asset.role==="video").sha256,previous.assets.find(asset=>asset.role==="video")!.sha256);
 assert.match(manifest.coverage.comments,/not_supported/);
});
test("retry restores stable capture paths after readable file names were published",async t=>{
 const {root,job}=await fixture(t);const id=contentIdentity(base),directory=path.join(root,"items",id),savedPath="视频/原片.mp4",capturePath="media/original-id/video.mp4";
 await fs.mkdir(path.join(directory,"视频"),{recursive:true});await fs.writeFile(path.join(directory,savedPath),"original-media");
 const body="![原片]("+encodeURI(savedPath)+")";await fs.writeFile(path.join(directory,"原始正文.md"),body);await fs.writeFile(path.join(directory,"资料正文.md"),body);await fs.writeFile(path.join(directory,"阅读.html"),"<p>原片</p>");
 await fs.writeFile(path.join(directory,"content.json"),JSON.stringify({...base,markdown:body,contentId:id,schemaVersion:1,namingVersion:1,status:"completed",aliases:[base.sourceUrl],updatedAt:base.capturedAt,contentHash:"fixture",bodyFile:"原始正文.md",markdownFile:"资料正文.md",readingFile:"阅读.html",assets:[{id:"video-stable",role:"video",status:"saved",path:savedPath,capturePath}]}));
 let acquired=false;
 await processContentJob(root,root,job,new AbortController().signal,{resolve:async i=>i,acquire:async(_input,context)=>{
   assert.equal(context.existing?.assets[0].path,capturePath);assert.equal(await fs.readFile(path.join(context.directory,capturePath),"utf8"),"original-media");
   assert.match(context.existing!.markdown,/media\/original-id\/video\.mp4/);acquired=true;return context.existing!;
 },enrich:async record=>record,pdf:async()=>undefined});
 assert.ok(acquired);
});
test("pipeline persists original content before enrichment fails",async t=>{
 const {root,job}=await fixture(t);await assert.rejects(processContentJob(path.join(root,"runtime"),root,job,new AbortController().signal,{resolve:async i=>i,acquire:async(i,c)=>{await c.onCheckpoint?.(base);return base;},enrich:async()=>{throw new Error("识别失败");},pdf:async()=>undefined}),/识别失败/);
 assert.equal((await findContent(root)).length,1);assert.ok((await getJobs(root))[0].contentId);
 assert.equal((await findContent(root))[0].status,"partial");
});
test("successful retry clears resolved login placeholders",async t=>{
 const {root,job}=await fixture(t);const deps={resolve:async(i:any)=>i,enrich:async(r:CapturedContent)=>r,pdf:async()=>undefined};
 const login=await processContentJob(root,root,job,new AbortController().signal,{...deps,acquire:async()=>({...base,markdown:"",assets:[{id:"login",role:"source",status:"login_required"}]})});assert.equal(login.state,"login_required");
 const saved=await processContentJob(root,root,job,new AbortController().signal,{...deps,acquire:async()=>base});assert.equal(saved.state,"completed");
});
test("copying reusable assets refuses a staging junction before writing",async t=>{
 const {root,job}=await fixture(t);const source=path.join(root,"source");await fs.mkdir(path.join(source,"images"),{recursive:true});await fs.writeFile(path.join(source,"images","1.png"),"image");
 await saveContent(root,{...base,assets:[{id:"i",role:"image",status:"saved",path:"images/1.png"}]},source);
 const stage=path.join(root,"staging",job.id),outside=path.join(root,"outside");await fs.mkdir(stage,{recursive:true});await fs.mkdir(outside);await fs.symlink(outside,path.join(stage,"images"),"junction");
 try{await processContentJob(root,root,job,new AbortController().signal,{resolve:async i=>i,acquire:async()=>base,enrich:async r=>r,pdf:async()=>undefined});}catch{}
 assert.deepEqual(await fs.readdir(outside),[]);
});
test("pipeline returns partial for missing OCR while original remains readable",async t=>{
 const {root,job}=await fixture(t);const result=await processContentJob(root,root,job,new AbortController().signal,{resolve:async i=>i,acquire:async()=>base,enrich:async r=>({...r,assets:[{id:"ocr",role:"ocr",status:"missing_dependency",reason:"缺引擎"}]}),pdf:async()=>undefined});
 assert.equal(result.state,"partial");const read=await readContent(root,result.contentId!);assert.equal(read.ok,true);if(read.ok)assert.match(read.text,/原始文字/);
});

test("legacy import takes the latest version once and leaves the old library untouched",async t=>{
 const {root}=await fixture(t),legacy=path.join(root,"legacy"),library=path.join(root,"library");
 const priorEnv=process.env.WECHAT_ARTICLE_LIBRARY_ROOT;process.env.WECHAT_ARTICLE_LIBRARY_ROOT=legacy;t.after(()=>{if(priorEnv===undefined)delete process.env.WECHAT_ARTICLE_LIBRARY_ROOT;else process.env.WECHAT_ARTICLE_LIBRARY_ROOT=priorEnv;});
 const sourceUrl="https://mp.weixin.qq.com/s/same-article";
 await saveArticle(legacy,{title:"旧版",sourceUrl,extractedAt:"2026-09-01T00:00:00Z",status:"complete",markdown:"这是旧版"});
 const newest=await saveArticle(legacy,{title:"新版",sourceUrl,extractedAt:"2026-09-06T00:00:00Z",status:"complete",markdown:"这是新版"});
 const before=await fs.readFile(path.join(newest.directory,"manifest.json"),"utf8");
 const first=await listSavedContent(root,library),second=await listSavedContent(root,library);
 assert.equal(first.length,1);assert.equal(first[0].title,"新版");assert.deepEqual(first,second);
 const read=await readContent(library,first[0].contentId);if(!read.ok)assert.fail(read.reason);assert.match(read.text,/这是新版/);assert.doesNotMatch(read.text,/这是旧版/);
 assert.equal(await fs.readFile(path.join(newest.directory,"manifest.json"),"utf8"),before);
});

async function cachedVideoFixture(t: any, platform: "wechat_channels" | "xiaohongshu" = "wechat_channels") {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), "link-service-video-"));
 t.after(() => fs.rm(root, { recursive: true, force: true }));
 t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
 const url = platform === "xiaohongshu" ? "https://xhslink.cn/o/Ao78ExGkuj9" : "https://weixin.qq.com/sph/AiFpm2ZuMh";
 const input = { platform, url, canonicalUrl: platform === "xiaohongshu" ? "https://www.xiaohongshu.com/explore/6accfa15000000001303c038" : url, nativeId: platform === "xiaohongshu" ? "6accfa15000000001303c038" : "sph:AiFpm2ZuMh" };
 const [job] = await enqueueInputs(root, [input]);
 const seed = path.join(root, "seed"); await fs.mkdir(path.join(seed, "video"), { recursive: true });
 await fs.writeFile(path.join(seed, "video", "001.mp4"), "previously-probed-original-video");
 const original: CapturedContent = { ...input, sourceUrl: url, title: "已核验视频", kind: "video", capturedAt: base.capturedAt, markdown: "原始视频说明", warnings: [], coverage: { media: "saved: 1 verified MP4 video" }, assets: [
  { id: "video/001", role: "video", status: "saved", path: "video/001.mp4", sourceUrl: "https://example.com/video.mp4?signature=EXPIRED_PLACEHOLDER", mime: "video/mp4", provenance: "original" }
 ] };
 const saved = await saveContent(root, original, seed);
 return { root, job, input, saved };
}

test("a derivative retry reuses a verified original video without calling an unavailable parser", async t => {
 const { root, job, saved } = await cachedVideoFixture(t);
 let networkCalls = 0; let enriched = false;
 t.mock.method(globalThis, "fetch", async () => { networkCalls++; throw new Error("parser is unavailable"); });
 const result = await processContentJob(root, root, job, new AbortController().signal, {
  resolve: async input => input,
  enrich: async (record, context) => {
   const video = record.assets.find(asset => asset.role === "video" && asset.status === "saved");
   assert.ok(video?.path, "the local original should reach enrichment");
   assert.equal(video.sha256, saved.assets[0].sha256);
   assert.equal(await fs.readFile(path.join(context.directory, video.path!), "utf8"), "previously-probed-original-video");
   assert.equal(record.markdown, "原始视频说明"); enriched = true; return record;
  }, pdf: async () => undefined
 });
 assert.ok(enriched); assert.equal(result.contentId, saved.contentId); assert.equal(networkCalls, 0);
});

test("a corrupted original cannot bypass reacquisition during a derivative retry", async t => {
 const { root, job, saved } = await cachedVideoFixture(t);
 const item = (await findContent(root)).find(item => item.contentId === saved.contentId)!;
 await fs.writeFile(item.videoPath!, "corrupted");
 let networkCalls = 0;
 t.mock.method(globalThis, "fetch", async () => { networkCalls++; return new Response("<body>在微信客户端打开</body>"); });
 await processContentJob(root, root, job, new AbortController().signal, { resolve: async input => input, enrich: async record => record, pdf: async () => undefined });
 assert.equal(networkCalls, 1);
});

test("an alias with a different native identity cannot reuse a cached video", async t => {
 const { root, job } = await cachedVideoFixture(t);
 let networkCalls = 0;
 t.mock.method(globalThis, "fetch", async () => { networkCalls++; return new Response("<body>在微信客户端打开</body>"); });
 await processContentJob(root, root, job, new AbortController().signal, { resolve: async input => ({ ...input, nativeId: "sph:Different" }), enrich: async record => record, pdf: async () => undefined });
 assert.equal(networkCalls, 1);
});

test("a saved Xiaohongshu short-link retry does not resolve or capture the share again", async t => {
 const { root, job, saved } = await cachedVideoFixture(t, "xiaohongshu");
 let networkCalls = 0; let browserCalls = 0;
 t.mock.method(globalThis, "fetch", async () => { networkCalls++; throw new Error("offline"); });
 t.mock.method(chromium, "launchPersistentContext", async () => { browserCalls++; throw new Error("no browser expected"); });
 const result = await processContentJob(root, root, job, new AbortController().signal, { enrich: async record => record, pdf: async () => undefined });
 assert.equal(result.contentId, saved.contentId);
 assert.equal(networkCalls, 0); assert.equal(browserCalls, 0);
});

async function restoreFixture(t: any) {
 const { root, job } = await fixture(t);
 const seed = path.join(root, "seed"); await fs.mkdir(path.join(seed, "images"), { recursive: true });
 const assets: CapturedContent["assets"] = [];
 for (const name of ["a", "b", "c"]) {
  await fs.writeFile(path.join(seed, "images", `${name}.png`), name.repeat(1024));
  assets.push({ id: name, role: "image", status: "saved", path: `images/${name}.png`, provenance: "original" });
 }
 await saveContent(root, { ...base, assets }, seed);
 return { root, job };
}

test("retry restoration reuses intact staging files without copying them again", async t => {
 const { root, job } = await restoreFixture(t);
 const deps = { resolve: async (input: any) => input, acquire: async (_input: any, context: any) => context.existing!, enrich: async (record: CapturedContent) => record, pdf: async () => undefined };
 await processContentJob(root, root, job, new AbortController().signal, deps);
 const copy = fs.copyFile; let copies = 0;
 t.mock.method(fs, "copyFile", async (...args: Parameters<typeof fs.copyFile>) => { copies++; return copy(...args); });
 await processContentJob(root, root, job, new AbortController().signal, deps);
 assert.equal(copies, 0);
});

test("cancelling during a restore does not start copies of the following assets", async t => {
 const { root, job } = await restoreFixture(t);
 const controller = new AbortController(); const copy = fs.copyFile; let copies = 0;
 t.mock.method(fs, "copyFile", async (...args: Parameters<typeof fs.copyFile>) => { copies++; await copy(...args); controller.abort(); });
 await assert.rejects(processContentJob(root, root, job, controller.signal, { resolve: async input => input, acquire: async (_input, context) => context.existing!, enrich: async record => record, pdf: async () => undefined }), { name: "AbortError" });
 assert.equal(copies, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import type { CapturedContent, ContentAsset } from "../src/content-types.js";

type AssetWithCapturePath = ContentAsset & { capturePath?: string };

const record = (assets: AssetWithCapturePath[], overrides: Partial<CapturedContent> = {}): CapturedContent => ({
  platform: "bilibili", title: "中文标题：资料整理", sourceUrl: "https://example.test/a", canonicalUrl: "https://example.test/a",
  capturedAt: "2026-09-06T00:00:00Z", kind: "video", markdown: "正文", warnings: [], assets,
  parts: [{ id: "p1", title: "第一集 开场", status: "saved" }, { id: "p2", title: "第二集 结尾", status: "saved" }], ...overrides
});

test("safeFilename keeps NFC Chinese while removing Windows-invalid and bidi characters", async () => {
  const { safeFilename } = await import("../src/content-naming.js");
  assert.equal(safeFilename("cafe\u0301：中文\u202E?.mp4 "), "café：中文.mp4");
  assert.equal(safeFilename("CON.txt"), "_CON.txt");
  assert.equal(safeFilename("...", "备选名称"), "备选名称");
  const shortened = safeFilename("中文标题很长很长很长很长很长很长.mp4", "未命名", 12);
  assert.ok([...shortened].length <= 12);
  assert.match(shortened, /\.mp4$/);
});

test("contentFolderName is readable, localized and bounded", async () => {
  const { contentFolderName } = await import("../src/content-naming.js");
  const name = contentFolderName(record([], { platform: "xiaohongshu", title: "很长的中文标题很长的中文标题很长的中文标题很长的中文标题很长的中文标题" }), "abcdef0123456789");
  assert.match(name, /^小红书 - /);
  assert.match(name, / \[abcdef01\]$/);
  const title = name.slice("小红书 - ".length, -" [abcdef01]".length);
  assert.ok([...title].length <= 40);
});

test("plans readable classified names without hashes and preserves capture paths", async () => {
  const { planAssetNames } = await import("../src/content-naming.js");
  const assets: AssetWithCapturePath[] = [
    { id: "video-hash-123", role: "video", status: "saved", path: "media/5cc77d/original [p1].mp4", partId: "p1", provenance: "original" },
    { id: "audio-hash-123", role: "audio", status: "saved", path: "derived/audio/hash.m4a", partId: "p1", provenance: "generated" },
    { id: "subtitle-platform", role: "subtitle", status: "saved", path: "media/subs/a.zh.vtt", partId: "p1", language: "zh", provenance: "platform_subtitle" },
    { id: "subtitle-machine", role: "subtitle", status: "saved", path: "derived/asr/a.srt", partId: "p1", language: "zh", provenance: "machine_asr" },
    { id: "frame-hash", role: "frame", status: "saved", path: "derived/frames/hash/frame-001.jpg", partId: "p2", startMs: 4_200, provenance: "sampled_frame" },
    { id: "ocr-hash", role: "ocr", status: "saved", path: "derived/ocr/hash.md", partId: "p2", startMs: 4_200, provenance: "machine_ocr" },
    { id: "info-hash", role: "source", status: "saved", path: "media/x.info.json", partId: "p1", provenance: "original" },
    { id: "asr-data", role: "source", status: "saved", path: "derived/asr/hash.json", partId: "p1", provenance: "machine_asr" },
    { id: "pdf", role: "pdf", status: "saved", path: "reading.pdf", provenance: "generated" },
    { id: "failed", role: "image", status: "failed", path: "partial.png", reason: "网络失败" }
  ];
  const planned = planAssetNames(record(assets)) as AssetWithCapturePath[];
  const byId = (id: string) => planned.find((asset) => asset.id === id)!;
  assert.equal(byId("video-hash-123").capturePath, "media/5cc77d/original [p1].mp4");
  assert.match(byId("video-hash-123").path ?? "", /^视频\/P01-第一集 开场\/视频001-第一集 开场\.mp4$/);
  assert.match(byId("audio-hash-123").path ?? "", /^音频\/P01-第一集 开场\/音频001-第一集 开场\.m4a$/);
  assert.match(byId("subtitle-platform").path ?? "", /字幕-zh-平台\.vtt$/);
  assert.match(byId("subtitle-machine").path ?? "", /字幕-zh-机器\.srt$/);
  assert.match(byId("frame-hash").path ?? "", /^截图\/P02-第二集 结尾\/截图-00-00-04-001\.jpg$/);
  assert.match(byId("ocr-hash").path ?? "", /^图片文字\/P02-第二集 结尾\/图片文字-00-00-04-001\.md$/);
  assert.match(byId("info-hash").path ?? "", /视频信息\.json$/);
  assert.match(byId("asr-data").path ?? "", /识别数据\.json$/);
  assert.equal(byId("pdf").path, "阅读.pdf");
  assert.equal(byId("failed").path, undefined);
  assert.equal(byId("failed").reason, "网络失败");
  assert.ok(planned.every((asset) => !/hash|[a-f0-9]{8,}/i.test(asset.path ?? "")));
  assert.match(byId("frame-hash").label ?? "", /P02 第二集 结尾 · 截图 00-00-04/);
});

test("incremental checkpoints retain sequence numbers and bounded filenames never become reserved devices",async()=>{
 const {safeFilename,planAssetNames}=await import("../src/content-naming.js");
 assert.notEqual(safeFilename("CONsole","x",3).toUpperCase(),"CON");assert.ok([...safeFilename("long.extension","x",1)].length<=1);
 assert.doesNotMatch(safeFilename("CON.more.txt"),/^con\./i);
 let previous:ContentAsset[]=[];
 for(let index=1;index<=3;index++){
   const frames:Array<ContentAsset>=Array.from({length:index},(_,i)=>({id:`frame-${i}`,role:"frame",status:"saved",path:`derived/frame-${i}.jpg`,startMs:i*4000}));
   previous=planAssetNames(record(frames),previous);assert.match(previous[index-1].path!,new RegExp(`-${String(index).padStart(3,"0")}\\.jpg$`));
 }
});

test("keeps prior asset assignments, reuses identical capture files, and avoids case-insensitive collisions", async () => {
  const { planAssetNames } = await import("../src/content-naming.js");
  const input: AssetWithCapturePath[] = [
    { id: "first", role: "image", status: "saved", path: "tmp/A.JPG", provenance: "original" },
    { id: "same-file", role: "cover", status: "saved", path: "tmp/A.JPG", provenance: "original" },
    { id: "other", role: "image", status: "saved", path: "tmp/a.jpg", provenance: "original" },
    { id: "old", role: "comments", status: "saved", path: "tmp/comments.json", provenance: "original" }
  ];
  const previous: AssetWithCapturePath[] = [{ id: "old", role: "comments", status: "saved", path: "评论/旧评论.json", capturePath: "tmp/comments.json", provenance: "original" }];
  const planned = planAssetNames(record(input), previous) as AssetWithCapturePath[];
  const byId = (id: string) => planned.find((asset) => asset.id === id)!;
  assert.equal(byId("first").path, byId("same-file").path);
  assert.notEqual(byId("first").path?.toLocaleLowerCase(), byId("other").path?.toLocaleLowerCase());
  assert.equal(byId("old").path, "评论/旧评论.json");
  assert.equal(byId("old").capturePath, "tmp/comments.json");
});

test("a retried asset with a changed format keeps the new extension and capture path",async()=>{
 const {planAssetNames}=await import("../src/content-naming.js");
 const old=planAssetNames(record([{id:"v",role:"video",status:"saved",path:"capture/v.mp4"}]));
 const next=planAssetNames(record([{id:"v",role:"video",status:"saved",path:"capture/v.webm"}]),old);
 assert.match(next[0].path!,/\.webm$/);assert.equal(next[0].capturePath,"capture/v.webm");
});

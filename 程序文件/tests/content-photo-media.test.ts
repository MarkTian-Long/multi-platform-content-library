import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { chromium } from "playwright-core";
import { savePhotoCollection, type PhotoMedia, type PhotoMediaDeps } from "../src/content-photo-media.js";
import { acquireContent } from "../src/content-acquisition.js";
import { contentStatus, saveContent, contentDirectory } from "../src/content-library.js";
import { renderReadingPage } from "../src/content-render.js";
import type { CapturedContent, ContentContext } from "../src/content-types.js";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL+XQAAAABJRU5ErkJggg==", "base64");
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const base = (): CapturedContent => ({ platform: "xiaohongshu", nativeId: "0123456789abcdef01234567", sourceUrl: "https://www.xiaohongshu.com/explore/0123456789abcdef01234567", canonicalUrl: "https://www.xiaohongshu.com/explore/0123456789abcdef01234567", title: "实况图集", markdown: "原始说明", kind: "gallery", capturedAt: "2026-10-14T00:00:00Z", processingMode: "original", assets: [], warnings: [], coverage: { body: "saved: original text" } });
const photo = (index: number): PhotoMedia => ({ id: `photo-${index}`, index, imageUrls: [`https://example.com/photo${index}.png`], motionExpected: true, motionUrls: [`https://example.com/motion${index}.mp4`], durationSeconds: 2 });
async function context(t: TestContext): Promise<ContentContext> {
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), "photo-media-"));
 t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("photo-media-")); await fs.rm(directory, { recursive: true, force: true }); });
 return { runtimeRoot: directory, directory };
}
function dependencies(calls: string[] = []): PhotoMediaDeps {
 return { saveAsset: async (url, directory, stem, role) => {
   calls.push(url); const bytes = role === "image" ? png : Buffer.concat([Buffer.from("000000186674797069736f6d0000000069736f6d69736f32", "hex"), Buffer.from(url)]), relative = `${stem}.${role === "image" ? "png" : "mp4"}`;
   await fs.mkdir(path.dirname(path.join(directory, relative)), { recursive: true }); await fs.writeFile(path.join(directory, relative), bytes);
   return { id: stem, role, status: "saved", path: relative, bytes: bytes.length, sha256: hash(bytes), sourceUrl: url, provenance: "original" };
 }, probeMedia: async () => ({ video: true, audio: false, durationSeconds: 2 }) };
}
test("photo collection reports unknown coverage for an empty declared gallery", async t => {
 const result = await savePhotoCollection(base(), [], await context(t), dependencies());
 assert.ok(result.assets.some(asset => asset.role === "image" && asset.status !== "saved"));
 assert.match(result.coverage!.photos, /^unknown:/); assert.equal(contentStatus(result), "partial");
});
test("reused image resource IDs at different photo positions retain distinct original motion companions", async t => {
 const ctx = await context(t), first = photo(1), second = { ...photo(2), id: first.id }, result = await savePhotoCollection(base(), [first, second], ctx, dependencies());
 const motions = result.assets.filter(asset => asset.role === "video"); assert.equal(motions.length, 2);
 assert.notEqual(motions[0].id, motions[1].id); assert.notEqual(motions[0].path, motions[1].path);
 for (const asset of motions) assert.equal(hash(await fs.readFile(path.join(ctx.directory, asset.path!))), asset.sha256);
 assert.deepEqual(result.parts?.map(part => part.title), ["第1张实况照片（动态视频）", "第2张实况照片（动态视频）"]);
});
test("a missing motion companion retains its original photo and never claims complete coverage", async t => {
 const result = await savePhotoCollection(base(), [{ ...photo(1), motionUrls: [] }], await context(t), dependencies());
 assert.equal(result.assets.find(asset => asset.role === "image")?.status, "saved");
 assert.equal(result.assets.find(asset => asset.role === "video")?.status, "unavailable"); assert.match(result.coverage!.livePhotos, /^unknown:/); assert.equal(contentStatus(result), "partial");
});

test("an explicitly protected motion is never downloaded or reused while the original photo survives", async t => {
 const ctx = await context(t), original = photo(1), first = await savePhotoCollection(base(), [original], ctx, dependencies()); ctx.existing = first;
 const calls: string[] = [], result = await savePhotoCollection(base(), [{ ...original, motionProtected: true }], ctx, dependencies(calls));
 assert.deepEqual(calls, []); assert.equal(result.assets.find(asset => asset.role === "image")?.status, "saved");
 assert.equal(result.assets.find(asset => asset.role === "video")?.status, "unavailable"); assert.match(result.assets.find(asset => asset.role === "video")!.reason!, /受保护或加密/); assert.equal(contentStatus(result), "partial");
});

test("offline reading pairs saved and missing motion results with their original photo numbers", async t => {
 const result = await savePhotoCollection(base(), [{ ...photo(1), motionUrls: [] }, photo(2)], await context(t), dependencies());
 assert.deepEqual(result.assets.map(asset => asset.label), ["第1张原图", "第1张实况照片（动态视频）", "第2张原图", "第2张实况照片（动态视频）"]);
 const html = renderReadingPage({ ...result, contentId: "0123456789abcdef", schemaVersion: 1, status: "partial", bodyFile: "正文.md", markdownFile: "正文.md", readingFile: "阅读.html", aliases: [], updatedAt: result.capturedAt, contentHash: "test-content-hash" }, result.markdown);
 assert.match(html, /图片 · 第1张原图/); assert.match(html, /视频 · 第1张实况照片（动态视频）/);
 assert.match(html, /实况照片动态：覆盖范围尚未确认/); assert.match(html, /图集原图：已保存本次可取得的内容/);
 assert.equal((html.match(/<video controls/g) || []).length, 1);
});

test("persisted gallery names and reader captions retain original photo positions", async t => {
 const ctx = await context(t), record = await savePhotoCollection(base(), [photo(1), { ...photo(3), motionUrls: [] }], ctx, dependencies()), root = path.join(ctx.directory, "library");
 const manifest = await saveContent(root, record, ctx.directory), images = manifest.assets.filter(asset => asset.role === "image");
 assert.deepEqual(images.map(asset => asset.label), ["第1张原图", "第3张原图"]);
 assert.deepEqual(images.map(asset => asset.path), ["图片/原图001.png", "图片/原图003.png"]);
 const reader = await fs.readFile(path.join(await contentDirectory(root, manifest.contentId), manifest.readingFile), "utf8");
 assert.match(reader, /图片 · 第3张原图/); assert.match(reader, /第3张实况照片（动态视频）/); assert.equal(manifest.status, "partial");
});

test("retaining a previously saved motion never hides a newly declared protected or missing gallery result", async t => {
 const ctx = await context(t), root = path.join(ctx.directory, "library"), first = await savePhotoCollection(base(), [photo(1)], ctx, dependencies());
 const prior = await saveContent(root, first, ctx.directory); ctx.existing = first;
 const current = await savePhotoCollection(base(), [{ ...photo(1), motionProtected: true }], ctx, dependencies());
 const manifest = await saveContent(root, current, ctx.directory);
 assert.equal(manifest.assets.find(asset => asset.role === "video")?.sha256, prior.assets.find(asset => asset.role === "video")?.sha256);
 assert.equal(manifest.status, "partial"); assert.match(manifest.coverage!.livePhotos, /^unknown:/);
});
test("photo collection checkpoints original image and first motion before cancellation", async t => {
 const ctx = await context(t), calls: string[] = [], controller = new AbortController(); ctx.signal = controller.signal;
 ctx.onCheckpoint = async record => { if (record.assets.some(asset => asset.role === "video" && asset.status === "saved")) controller.abort(); };
 const record = base(); await assert.rejects(savePhotoCollection(record, [photo(1), photo(2)], ctx, dependencies(calls)));
 assert.deepEqual(calls, [...photo(1).imageUrls, ...photo(1).motionUrls]); assert.equal(record.assets.filter(asset => asset.status === "saved").length, 2);
});
test("photo retries with changed signatures reuse hashed original images and motion files", async t => {
 const ctx = await context(t), original = photo(1); original.imageUrls[0] += "?token=old"; original.motionUrls[0] += "?signature=old&expires=1";
 const first = await savePhotoCollection(base(), [original], ctx, dependencies()); ctx.existing = first;
 const updated = { ...photo(1), imageUrls: [original.imageUrls[0].replace("old", "new")], motionUrls: [original.motionUrls[0].replace("old", "new").replace("expires=1", "expires=2")] }, calls: string[] = [];
 const result = await savePhotoCollection(base(), [updated], ctx, { ...dependencies(), saveAsset: async (url) => { calls.push(url); throw new Error("Network forbidden during verified reuse"); } });
 assert.deepEqual(calls, []); assert.deepEqual(result.assets.map(asset => asset.sha256), first.assets.map(asset => asset.sha256)); assert.equal(contentStatus(result), "completed");
});
test("invalid replacement video stays in its transaction and cannot overwrite a prior original", async t => {
 const ctx = await context(t), first = await savePhotoCollection(base(), [photo(1)], ctx, dependencies()); ctx.existing = first;
 const previous = first.assets.find(asset => asset.role === "video")!, digest = previous.sha256;
 const changed = { ...photo(1), motionUrls: ["https://example.com/new-resource.mp4"] }, injected = dependencies(), write = injected.saveAsset!;
 injected.saveAsset = async (...args) => { const asset = await write(...args); if (args[3] === "video") { await fs.writeFile(path.join(args[1], asset.path!), "HTML wrapper"); asset.bytes = 12; asset.sha256 = hash(Buffer.from("HTML wrapper")); } return asset; };
 const result = await savePhotoCollection(base(), [changed], ctx, injected);
 assert.equal(result.assets.find(asset => asset.role === "video")?.status, "failed"); assert.equal(hash(await fs.readFile(path.join(ctx.directory, previous.path!))), digest);
});
test("photo budget exhaustion explicitly preserves a partial collection", async t => {
 const result = await savePhotoCollection(base(), [photo(1)], await context(t), { ...dependencies(), maxTotalBytes: png.length });
 assert.equal(result.assets.find(asset => asset.role === "image")?.status, "saved"); assert.equal(result.assets.find(asset => asset.role === "video")?.status, "skipped"); assert.equal(contentStatus(result), "partial");
});

test("photo motion probing uses system PATH when no configured or project-local ffprobe exists", async t => {
 const ctx = await context(t), prior = process.env.CONTENT_FFPROBE_PATH; delete process.env.CONTENT_FFPROBE_PATH;
 t.after(() => { if (prior === undefined) delete process.env.CONTENT_FFPROBE_PATH; else process.env.CONTENT_FFPROBE_PATH = prior; });
 const commands: string[] = [];
 const result = await savePhotoCollection(base(), [photo(1)], ctx, { ...dependencies(), probeMedia: undefined, runTool: async (command, args) => {
  commands.push(command); assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file,pipe");
  return { code: 0, stdout: JSON.stringify({ streams: [{ codec_type: "video" }], format: { duration: "2" } }), stderr: "", timedOut: false, cancelled: false, outputTruncated: false };
 } });
 assert.deepEqual(commands, ["ffprobe"]); assert.equal(result.assets.find(asset => asset.role === "video")?.status, "saved");
});
test("Xiaohongshu acquisition saves photo-level motion alongside original images", async t => {
 t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
 const ctx = await context(t), source = base(), current = { url: source.sourceUrl, canonicalUrl: source.canonicalUrl, platform: source.platform, nativeId: source.nativeId, processing: "original" as const };
 const result = await acquireContent(current, ctx, { captureXiaohongshu: async () => ({ finalUrl: source.canonicalUrl, title: source.title, body: source.markdown, images: [], videos: [], photos: [photo(1)] }), probeMedia: dependencies().probeMedia, photoMedia: dependencies() } as Parameters<typeof acquireContent>[2]);
 assert.equal(result.assets.filter(asset => asset.role === "image" && asset.status === "saved").length, 1);
 assert.equal(result.assets.filter(asset => asset.role === "video" && asset.status === "saved").length, 1); assert.equal(result.kind, "gallery");
});

test("a shorter Xiaohongshu browser gallery cannot erase publicly confirmed photo and motion gaps", async t => {
 t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
 const ctx = await context(t), source = base(), publicPhotos = [{ fileId: "first", urlDefault: "https://example.com/first.png" }, { fileId: "second", urlDefault: "https://example.com/second.png", livePhoto: true }];
 const html = (images: unknown[]) => `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: { [source.nativeId!]: { note: { noteId: source.nativeId, title: source.title, desc: source.markdown, type: "normal", imageList: images } } } } })};</script>`;
 t.mock.method(globalThis, "fetch", async () => new Response(html(publicPhotos)));
 const page = { goto: async () => {}, waitForFunction: async () => {}, url: () => source.canonicalUrl, content: async () => html(publicPhotos.slice(0, 1)), locator: () => ({ innerText: async () => source.markdown }) };
 t.mock.method(chromium, "launchPersistentContext", async () => ({ pages: () => [page], route: async () => {}, close: async () => {} }) as never);
 const result = await acquireContent({ platform: source.platform, nativeId: source.nativeId, canonicalUrl: source.canonicalUrl, url: source.sourceUrl, processing: "original" }, ctx, { photoMedia: dependencies() });
 assert.equal(result.assets.filter(asset => asset.role === "image" && asset.status === "saved").length, 2);
 assert.equal(result.assets.filter(asset => asset.role === "video" && asset.status === "unavailable").length, 1);
 assert.match(result.coverage!.photos, /2\/2/); assert.match(result.coverage!.livePhotos, /0\/1/); assert.equal(contentStatus(result), "partial");
});

test("conflicting photo IDs across public and browser snapshots never combine another photo's motion", async t => {
 t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
 const ctx = await context(t), source = base(), calls: string[] = [];
 const html = (image: unknown) => `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: { [source.nativeId!]: { note: { noteId: source.nativeId, desc: source.markdown, imageList: [image] } } } } })};</script>`;
 t.mock.method(globalThis, "fetch", async () => new Response(html({ fileId: "public-photo", urlDefault: "https://example.com/public.png", livePhoto: true })));
 const page = { goto: async () => {}, waitForFunction: async () => {}, url: () => source.canonicalUrl, content: async () => html({ fileId: "different-photo", urlDefault: "https://example.com/other.png", livePhoto: true, stream: { h264: [{ masterUrl: "https://example.com/other-motion.mp4" }] } }), locator: () => ({ innerText: async () => source.markdown }) };
 t.mock.method(chromium, "launchPersistentContext", async () => ({ pages: () => [page], route: async () => {}, close: async () => {} }) as never);
 const result = await acquireContent({ platform: source.platform, nativeId: source.nativeId, canonicalUrl: source.canonicalUrl, url: source.sourceUrl, processing: "original" }, ctx, { photoMedia: dependencies(calls) });
 assert.deepEqual(calls, ["https://example.com/public.png"]);
 assert.equal(result.assets.find(asset => asset.role === "video")?.status, "unavailable"); assert.ok(result.warnings.length); assert.equal(contentStatus(result), "partial");
});

test("an unavailable Xiaohongshu browser preserves accessible public photos and declared motion gaps", async t => {
 t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
 const ctx = await context(t), source = base();
 const html = `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: { [source.nativeId!]: { note: { noteId: source.nativeId, desc: source.markdown, imageList: [{ fileId: "public-photo", urlDefault: "https://example.com/public.png", livePhoto: true }] } } } } })};</script>`;
 t.mock.method(globalThis, "fetch", async () => new Response(html));
 t.mock.method(chromium, "launchPersistentContext", async () => { throw new Error("Browser unavailable"); });
 const result = await acquireContent({ platform: source.platform, nativeId: source.nativeId, canonicalUrl: source.canonicalUrl, url: source.sourceUrl, processing: "original" }, ctx, { photoMedia: dependencies() });
 assert.equal(result.markdown, source.markdown); assert.equal(result.assets.find(asset => asset.role === "image")?.status, "saved");
 assert.equal(result.assets.find(asset => asset.role === "video")?.status, "unavailable"); assert.equal(contentStatus(result), "partial");
});

test("Xiaohongshu browser enrichment cannot reintroduce a publicly declared protected photo motion", async t => {
 t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
 const ctx = await context(t), source = base(), calls: string[] = [];
 const html = (protectedStream: boolean) => `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: { [source.nativeId!]: { note: { noteId: source.nativeId, desc: source.markdown, imageList: [{ fileId: "photo", urlDefault: "https://example.com/photo.png", livePhoto: true, stream: { has_drm: protectedStream, h264: [{ masterUrl: "https://example.com/motion.mp4", duration: 2000 }] } }] } } } } })};</script>`;
 t.mock.method(globalThis, "fetch", async () => new Response(html(true)));
 const page = { goto: async () => {}, waitForFunction: async () => {}, url: () => source.canonicalUrl, content: async () => html(false), locator: () => ({ innerText: async () => source.markdown }) };
 t.mock.method(chromium, "launchPersistentContext", async () => ({ pages: () => [page], route: async () => {}, close: async () => {} }) as never);
 const result = await acquireContent({ platform: source.platform, nativeId: source.nativeId, canonicalUrl: source.canonicalUrl, url: source.sourceUrl, processing: "original" }, ctx, { photoMedia: dependencies(calls) });
 assert.deepEqual(calls, ["https://example.com/photo.png"]); assert.equal(result.assets.find(asset => asset.role === "video")?.status, "unavailable"); assert.equal(contentStatus(result), "partial");
});

test("a whole protected Xiaohongshu video blocks supplied quality candidates and legacy video aliases", async t => {
 t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
 const ctx = await context(t), source = base(), calls: string[] = [], url = "https://example.com/protected.mp4";
 const result = await acquireContent({ platform: source.platform, nativeId: source.nativeId, canonicalUrl: source.canonicalUrl, url: source.sourceUrl, processing: "original" }, ctx, { captureXiaohongshu: async () => ({ finalUrl: source.canonicalUrl, title: source.title, body: source.markdown, images: [], videos: [url], videoExpected: true, videoProtected: true, videoCandidates: [{ url, source: "provided", rendition: "playback", watermark: "unknown" }] }), photoMedia: dependencies(calls) } as Parameters<typeof acquireContent>[2]);
 assert.deepEqual(calls, []); assert.equal(result.assets.find(asset => asset.role === "video")?.status, "unavailable"); assert.match(result.assets.find(asset => asset.role === "video")!.reason!, /受保护或加密/); assert.equal(contentStatus(result), "partial");
});

test("public whole-video protection survives an unprotected same-note Edge fallback with a different URL", async t => {
 t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
 const ctx = await context(t), source = base(), calls: string[] = [];
 const html = (protectedStream: boolean, url: string) => `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: { [source.nativeId!]: { note: { noteId: source.nativeId, desc: source.markdown, type: "video", video: { has_drm: protectedStream, media: { stream: { h264: [{ masterUrl: url, duration: 2000 }] } } } } } } } })};</script>`;
 t.mock.method(globalThis, "fetch", async () => new Response(html(true, "https://example.com/protected-state.mp4")));
 const page = { goto: async () => {}, waitForFunction: async () => {}, url: () => source.canonicalUrl, content: async () => html(false, "https://example.com/edge-alias.mp4"), locator: () => ({ innerText: async () => source.markdown }) };
 t.mock.method(chromium, "launchPersistentContext", async () => ({ pages: () => [page], route: async () => {}, close: async () => {} }) as never);
 const result = await acquireContent({ platform: source.platform, nativeId: source.nativeId, canonicalUrl: source.canonicalUrl, url: source.sourceUrl, processing: "original" }, ctx, { photoMedia: dependencies(calls), probeMedia: dependencies().probeMedia });
 assert.deepEqual(calls, []); assert.equal(result.assets.find(asset => asset.role === "video")?.status, "unavailable"); assert.equal(contentStatus(result), "partial");
});

test("publicly protected photo motion cannot be reassigned to another photo through same-note Edge enrichment", async t => {
 t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
 const ctx = await context(t), source = base(), calls: string[] = [], protectedUrl = "https://example.com/protected-motion.mp4";
 const html = (browser: boolean) => `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: { [source.nativeId!]: { note: { noteId: source.nativeId, desc: source.markdown, type: "normal", imageList: [{ fileId: "first-photo", urlDefault: "https://example.com/first.png", livePhoto: true, ...(browser ? {} : { stream: { has_drm: true, h264: [{ masterUrl: protectedUrl, duration: 2000 }] } }) }, { fileId: "second-photo", urlDefault: "https://example.com/second.png", livePhoto: true, ...(browser ? { stream: { h264: [{ masterUrl: protectedUrl, duration: 2000 }] } } : {}) }] } } } } })};</script>`;
 t.mock.method(globalThis, "fetch", async () => new Response(html(false)));
 const page = { goto: async () => {}, waitForFunction: async () => {}, url: () => source.canonicalUrl, content: async () => html(true), locator: () => ({ innerText: async () => source.markdown }) };
 t.mock.method(chromium, "launchPersistentContext", async () => ({ pages: () => [page], route: async () => {}, close: async () => {} }) as never);
 const result = await acquireContent({ platform: source.platform, nativeId: source.nativeId, canonicalUrl: source.canonicalUrl, url: source.sourceUrl, processing: "original" }, ctx, { photoMedia: dependencies(calls) });
 assert.deepEqual(calls, ["https://example.com/first.png", "https://example.com/second.png"]); assert.equal(result.assets.filter(asset => asset.role === "video" && asset.status === "saved").length, 0); assert.equal(contentStatus(result), "partial");
});

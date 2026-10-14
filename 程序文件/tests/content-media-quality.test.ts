import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { prioritizeMediaCandidates } from "../src/content-media-quality.js";
import { savePhotoCollection, type MediaCandidate, type PhotoMedia, type PhotoMediaDeps } from "../src/content-photo-media.js";
import { contentDirectory, saveContent } from "../src/content-library.js";
import type { CapturedContent, ContentContext } from "../src/content-types.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const candidate = (url: string, overrides: Partial<MediaCandidate> = {}): MediaCandidate => ({ url, source: "provided", rendition: "playback", watermark: "unknown", ...overrides });
const record = (): CapturedContent => ({ platform: "xiaohongshu", nativeId: "0123456789abcdef01234567", sourceUrl: "https://www.xiaohongshu.com/explore/0123456789abcdef01234567", canonicalUrl: "https://www.xiaohongshu.com/explore/0123456789abcdef01234567", title: "画质验证", markdown: "保留图片和动态", kind: "gallery", capturedAt: "2026-10-14T00:00:00Z", processingMode: "original", assets: [], warnings: [] });
const photo = (overrides: Partial<PhotoMedia> = {}): PhotoMedia => ({ id: "original-photo", index: 1, imageUrls: [], motionUrls: [], motionExpected: false, ...overrides });
async function context(t: TestContext): Promise<ContentContext> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "media-quality-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("media-quality-")); await fs.rm(directory, { recursive: true, force: true }); });
  return { runtimeRoot: directory, directory };
}
function box(name: string, bytes: Buffer): Buffer { const head = Buffer.alloc(8); head.writeUInt32BE(8 + bytes.length); head.write(name, 4); return Buffer.concat([head, bytes]); }
// Structural HEIC fixture exercises container identification and byte preservation, not codec decoding.
function heic(width: number, height: number): Buffer {
  const dimensions = Buffer.alloc(12); dimensions.writeUInt32BE(width, 4); dimensions.writeUInt32BE(height, 8);
  return Buffer.concat([box("ftyp", Buffer.from("heic\0\0\0\0heic")), box("meta", Buffer.concat([Buffer.alloc(4), box("iprp", box("ipco", box("ispe", dimensions)))]))]);
}
function png(width: number, height: number): Buffer {
  const chunk = (name: string, bytes: Buffer) => { const contents = Buffer.concat([Buffer.from(name), bytes]); let crc = 0xffffffff; for (const value of contents) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } const length = Buffer.alloc(4), tail = Buffer.alloc(4); length.writeUInt32BE(bytes.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([length, contents, tail]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk("IEND", Buffer.alloc(0))]);
}
function files(values: Record<string, { bytes: Buffer; extension: string }>, calls: string[] = []): PhotoMediaDeps {
  return { saveAsset: async (url, directory, stem, role) => { calls.push(url); const value = values[url]; if (!value) return { id: stem, role, status: "failed", reason: "HTTP 403" }; const relative = `${stem}.${value.extension}`; await fs.mkdir(path.dirname(path.join(directory, relative)), { recursive: true }); await fs.writeFile(path.join(directory, relative), value.bytes); return { id: stem, role, status: "saved", path: relative, bytes: value.bytes.length, sha256: digest(value.bytes), sourceUrl: url, provenance: "original" }; } };
}

test("candidate choice prefers declared clean streams, then highest actual source dimensions and bitrate", () => {
  const selected = prioritizeMediaCandidates([candidate("https://example.com/marked.mp4", { watermark: "present", width: 2160, height: 3840 }), candidate("https://example.com/unknown.mp4", { width: 1080, height: 1920 }), candidate("https://example.com/clean-small.mp4", { watermark: "none", width: 720, height: 1280, bitrate: 9e6 }), candidate("https://example.com/clean-large.mp4", { watermark: "none", width: 1080, height: 1920, bitrate: 3e6 })]);
  assert.deepEqual(selected.map(item => new URL(item.url).pathname), ["/clean-large.mp4", "/clean-small.mp4", "/unknown.mp4", "/marked.mp4"]);
});
test("same URL aliases retain bitrate metadata and conservative watermark evidence", () => {
  const same = "https://example.com/shared.mp4", selected = prioritizeMediaCandidates([candidate(same, { width: 720, height: 960 }), candidate(same, { width: 720, height: 960, bitrate: 3e6, watermark: "none", evidence: "platform_flag" }), candidate("https://example.com/other.mp4", { width: 720, height: 960, bitrate: 2.5e6, watermark: "none" })]);
  assert.equal(selected[0].url, same); assert.equal(selected[0].bitrate, 3e6);
  const contradictory = prioritizeMediaCandidates([candidate(same, { watermark: "present", evidence: "known_template" }), candidate(same, { watermark: "none", evidence: "platform_flag", width: 1080, height: 1920 })]);
  assert.equal(contradictory[0].watermark, "present"); assert.equal(contradictory[0].evidence, "known_template");
});
test("photo saving chooses a supplied full resolution picture instead of a marked download template", async t => {
  const ctx = await context(t), clean = "https://example.com/full.png?signature=unchanged", marked = "https://example.com/water.png", bytes = png(32, 48), calls: string[] = [];
  const result = await savePhotoCollection(record(), [photo({ width: 32, height: 48, imageUrls: [marked, clean], imageCandidates: [candidate(marked, { watermark: "present", evidence: "known_template", width: 32, height: 48 }), candidate(clean, { width: 32, height: 48 })] })], ctx, files({ [clean]: { bytes, extension: "png" }, [marked]: { bytes: png(32, 48), extension: "png" } }, calls));
  assert.deepEqual(calls, [clean]); const asset = result.assets.find(asset => asset.role === "image")!;
  assert.equal(asset.sha256, digest(bytes)); assert.equal(asset.quality?.width, 32); assert.equal(asset.quality?.height, 48); assert.equal(asset.quality?.watermark, "unknown"); assert.equal(asset.quality?.resolution, "matches_source");
});
test("HEIC original retains its container bytes and a separately labelled supplied preview", async t => {
  const ctx = await context(t), original = "https://example.com/original-object", preview = "https://example.com/preview.png", bytes = heic(3024, 4032), previewBytes = png(18, 24);
  const result = await savePhotoCollection(record(), [photo({ imageUrls: [preview], imageCandidates: [candidate(original, { source: "platform_object", rendition: "original" }), candidate(preview)] })], ctx, files({ [original]: { bytes, extension: "bin" }, [preview]: { bytes: previewBytes, extension: "png" } }));
  const raw = result.assets.find(asset => asset.role === "image")!, web = result.assets.find(asset => asset.id === "images/001-preview")!;
  assert.equal(raw.status, "saved"); assert.match(raw.path!, /\.heic$/); assert.equal(raw.sha256, digest(bytes)); assert.equal(raw.quality?.width, 3024); assert.equal(raw.quality?.rendition, "original"); assert.equal(raw.quality?.source, "platform_object");
  assert.equal(web.status, "saved"); assert.equal(web.quality?.rendition, "preview"); assert.equal(web.sha256, digest(previewBytes));
  const library = path.join(ctx.directory, "library"), manifest = await saveContent(library, result, ctx.directory), directory = await contentDirectory(library, manifest.contentId), reader = await fs.readFile(path.join(directory, manifest.readingFile), "utf8");
  assert.equal(manifest.assets.find(asset => asset.id === raw.id)?.path, "图片/原图001.heic"); assert.equal(manifest.assets.find(asset => asset.id === web.id)?.path, "图片/预览001.png");
  assert.match(reader, /3024 × 4032/); assert.match(reader, /HEIC/); assert.match(reader, /第1张网页预览/); assert.doesNotMatch(reader, /<img[^>]*\.heic/); assert.doesNotMatch(reader, /水印：无/);
});
test("unavailable original falls back to a provided preview with measured smaller dimensions", async t => {
  const ctx = await context(t), original = "https://example.com/original", preview = "https://example.com/preview.png", calls: string[] = [];
  const result = await savePhotoCollection(record(), [photo({ width: 32, height: 48, imageUrls: [preview], imageCandidates: [candidate(original, { source: "platform_object", rendition: "original" }), candidate(preview)] })], ctx, files({ [preview]: { bytes: png(16, 24), extension: "png" } }, calls));
  assert.deepEqual(calls, [original, preview]); const asset = result.assets[0]; assert.equal(asset.status, "saved"); assert.equal(asset.quality?.rendition, "playback"); assert.equal(asset.quality?.resolution, "smaller_than_source"); assert.equal(asset.quality?.width, 16);
});
test("a lower resolution fallback cannot overwrite a verified higher quality file of the same photo", async t => {
  const ctx = await context(t), high = "https://example.com/high.png", low = "https://example.com/low.png", highBytes = png(32, 48);
  const first = await savePhotoCollection(record(), [photo({ width: 32, height: 48, imageCandidates: [candidate(high, { source: "platform_object", rendition: "original" })] })], ctx, files({ [high]: { bytes: highBytes, extension: "png" } })); ctx.existing = first;
  const result = await savePhotoCollection(record(), [photo({ width: 32, height: 48, imageCandidates: [candidate(low)] })], ctx, files({ [low]: { bytes: png(16, 24), extension: "png" } }));
  assert.equal(result.assets[0].sha256, digest(highBytes)); assert.equal(digest(await fs.readFile(path.join(ctx.directory, first.assets[0].path!))), digest(highBytes)); assert.equal(result.assets[0].quality?.width, 32);
});
test("higher quality retention cannot carry a different original photo into the same numbered slot", async t => {
  const ctx = await context(t), high = "https://example.com/old.png", changed = "https://example.com/changed.png", changedBytes = png(16, 24);
  const first = await savePhotoCollection(record(), [photo({ imageCandidates: [candidate(high, { rendition: "original" })] })], ctx, files({ [high]: { bytes: png(32, 48), extension: "png" } })); ctx.existing = first;
  const result = await savePhotoCollection(record(), [photo({ id: "different-photo", imageCandidates: [candidate(changed)] })], ctx, files({ [changed]: { bytes: changedBytes, extension: "png" } }));
  assert.equal(result.assets[0].sha256, digest(changedBytes)); assert.notEqual(result.assets[0].quality?.resourceId, first.assets[0].quality?.resourceId);
});
test("video quality uses measured video size and address metadata rather than the larger companion image", async t => {
  const ctx = await context(t), url = "https://example.com/clean.mp4", bytes = box("ftyp", Buffer.from("isom\0\0\0\0isom"));
  const result = await savePhotoCollection(record(), [photo({ width: 1440, height: 1920, motionExpected: true, motionCandidates: [candidate(url, { watermark: "none", evidence: "platform_flag", width: 720, height: 960, durationSeconds: 3 })], durationSeconds: 3 })], ctx, { ...files({ [url]: { bytes, extension: "mp4" } }), probeMedia: async () => ({ video: true, audio: false, durationSeconds: 3, width: 720, height: 960 }) });
  const video = result.assets.find(asset => asset.role === "video")!; assert.equal(video.status, "saved"); assert.equal(video.quality?.width, 720); assert.equal(video.quality?.expectedWidth, 720); assert.equal(video.quality?.resolution, "matches_source"); assert.equal(video.quality?.watermark, "none"); assert.equal(video.quality?.evidence, "platform_flag");
});
test("explicitly protected motion cannot be reintroduced by quality candidates", async t => {
  const ctx = await context(t), url = "https://example.com/protected.mp4", calls: string[] = [];
  const result = await savePhotoCollection(record(), [photo({ motionExpected: true, motionProtected: true, motionCandidates: [candidate(url, { watermark: "none" })] })], ctx, files({}, calls));
  assert.deepEqual(calls, []); assert.equal(result.assets.find(asset => asset.role === "video")?.status, "unavailable");
});
test("a later higher resolution main stream survives a large backup candidate list", () => {
  const backups = Array.from({ length: 320 }, (_, index) => candidate(`https://example.com/backup-${index}.mp4`, { width: 720, height: 960 }));
  assert.equal(prioritizeMediaCandidates([...backups, candidate("https://example.com/high.mp4", { width: 2160, height: 2880 })])[0].url, "https://example.com/high.mp4");
});
test("HEIC and its verified provided preview both reuse bytes when signed addresses refresh", async t => {
  const ctx = await context(t), original = "https://example.com/raw", preview = "https://example.com/preview.png?token=old", makePhoto = (url: string) => photo({ imageUrls: [url], imageCandidates: [candidate(original, { source: "platform_object", rendition: "original" }), candidate(url)] });
  const first = await savePhotoCollection(record(), [makePhoto(preview)], ctx, files({ [original]: { bytes: heic(3024, 4032), extension: "heic" }, [preview]: { bytes: png(18, 24), extension: "png" } })); ctx.existing = first;
  const calls: string[] = [], next = await savePhotoCollection(record(), [makePhoto(preview.replace("old", "new"))], ctx, files({}, calls));
  assert.deepEqual(calls, []); assert.deepEqual(next.assets.map(asset => asset.sha256), first.assets.map(asset => asset.sha256));
});
test("new motion resource metadata cannot retain an older better marked clip of a different resource", async t => {
  const ctx = await context(t), old = "https://example.com/old.mp4", next = "https://example.com/next.mp4", header = box("ftyp", Buffer.from("isom\0\0\0\0isom")), oldBytes = Buffer.concat([header, Buffer.from("old")]), nextBytes = Buffer.concat([header, Buffer.from("new")]);
  const makePhoto = (url: string, id: string, watermark: MediaCandidate["watermark"]) => photo({ motionExpected: true, motionCandidates: [candidate(url, { resourceId: id, watermark })], durationSeconds: 3 });
  const probeMedia = async () => ({ video: true, audio: false, durationSeconds: 3, width: 720, height: 960 });
  const first = await savePhotoCollection(record(), [makePhoto(old, "old-resource", "none")], ctx, { ...files({ [old]: { bytes: oldBytes, extension: "mp4" } }), probeMedia }); ctx.existing = first;
  const result = await savePhotoCollection(record(), [makePhoto(next, "next-resource", "unknown")], ctx, { ...files({ [next]: { bytes: nextBytes, extension: "mp4" } }), probeMedia });
  const before = first.assets.find(asset => asset.role === "video")!, after = result.assets.find(asset => asset.role === "video")!;
  assert.equal(after.sha256, digest(nextBytes)); assert.notEqual(after.quality?.resourceId, before.quality?.resourceId);
});
test("cached motion rechecks the currently selected candidate duration before claiming saved", async t => {
  const ctx = await context(t), url = "https://example.com/same.mp4", bytes = box("ftyp", Buffer.from("isom\0\0\0\0isom")), deps = { ...files({ [url]: { bytes, extension: "mp4" } }), probeMedia: async () => ({ video: true, audio: false, durationSeconds: 3 }) };
  const makePhoto = (durationSeconds: number) => photo({ motionExpected: true, motionCandidates: [candidate(url, { durationSeconds })] });
  const first = await savePhotoCollection(record(), [makePhoto(3)], ctx, deps); ctx.existing = first;
  const result = await savePhotoCollection(record(), [makePhoto(30)], ctx, deps), original = first.assets.find(asset => asset.role === "video")!;
  assert.notEqual(result.assets.find(asset => asset.role === "video")?.status, "saved"); assert.match(result.coverage!.livePhotos, /^unknown:/);
  assert.equal(digest(await fs.readFile(path.join(ctx.directory, original.path!))), original.sha256);
});
test("identical cached bytes retain known watermark evidence despite a later clean metadata alias", async t => {
  const ctx = await context(t), url = "https://example.com/same.mp4", bytes = box("ftyp", Buffer.from("isom\0\0\0\0isom")), deps = { ...files({ [url]: { bytes, extension: "mp4" } }), probeMedia: async () => ({ video: true, audio: false, durationSeconds: 3 }) };
  const makePhoto = (watermark: MediaCandidate["watermark"], evidence: MediaCandidate["evidence"]) => photo({ motionExpected: true, motionCandidates: [candidate(url, { watermark, evidence })] });
  const first = await savePhotoCollection(record(), [makePhoto("present", "known_template")], ctx, deps); ctx.existing = first;
  const result = await savePhotoCollection(record(), [makePhoto("none", "platform_flag")], ctx, deps), video = result.assets.find(asset => asset.role === "video")!;
  assert.equal(video.quality?.watermark, "present"); assert.equal(video.quality?.evidence, "known_template"); assert.equal(video.sha256, first.assets.find(asset => asset.role === "video")!.sha256);
});
test("original-object upgrade reuses the verified old web picture as its preview without a duplicate download", async t => {
  const ctx = await context(t), original = "https://example.com/raw", preview = "https://example.com/preview.png", previewBytes = png(18, 24);
  const first = await savePhotoCollection(record(), [photo({ imageUrls: [preview] })], ctx, files({ [preview]: { bytes: previewBytes, extension: "png" } })); ctx.existing = first;
  const library = path.join(ctx.directory, "library"); await saveContent(library, first, ctx.directory);
  const calls: string[] = [], next = await savePhotoCollection(record(), [photo({ imageUrls: [preview], imageCandidates: [candidate(original, { source: "platform_object", rendition: "original" }), candidate(preview)] })], ctx, files({ [original]: { bytes: heic(3024, 4032), extension: "heic" } }, calls));
  assert.deepEqual(calls, [original]); const web = next.assets.find(asset => asset.id === "images/001-preview")!;
  assert.equal(web.sha256, digest(previewBytes)); assert.equal(web.quality?.rendition, "preview"); assert.equal(web.path, first.assets[0].path);
  const saved = await saveContent(library, next, ctx.directory), directory = await contentDirectory(library, saved.contentId), names = await fs.readdir(path.join(directory, "图片"));
  assert.equal(names.filter(name => name.endsWith(".png")).length, 1); assert.equal(saved.assets.find(asset => asset.id === web.id)?.path, "图片/原图001.png");
});

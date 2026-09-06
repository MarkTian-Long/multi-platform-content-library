import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CapturedContent, ContentContext } from "../src/content-types.js";

function record(assets: CapturedContent["assets"]): CapturedContent {
  return {
    platform: "web", sourceUrl: "https://example.test/post", canonicalUrl: "https://example.test/post",
    title: "媒体样例", capturedAt: "2026-09-06T00:00:00.000Z", kind: "video", markdown: "正文", assets, warnings: [],
    parts: [{ id: "p1", title: "第一段", status: "saved", durationSeconds: 2 }]
  };
}

test("turns a valid platform subtitle into timestamped Markdown without changing the original", async (t) => {
  const enrichment = await import("../src/content-enrichment.js");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "content-enrichment-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, "assets"));
  await fs.writeFile(path.join(directory, "assets", "subtitle.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:01.250\n你好\n\n00:00:01.250 --> 00:00:02.000\n世界\n");
  const content = await enrichment.enrichContent(record([{ id: "sub-1", role: "subtitle", status: "saved", path: "assets/subtitle.vtt", provenance: "platform_subtitle", language: "zh", partId: "p1" }]), { runtimeRoot: directory, directory });
  const transcript = content.assets.find((asset: { role: string; provenance?: string }) => asset.role === "transcript" && asset.provenance === "platform_subtitle");
  assert.ok(transcript?.path);
  const markdown = await fs.readFile(path.join(directory, transcript.path!), "utf8");
  assert.match(markdown, /00:00\.000/);
  assert.match(markdown, /你好/);
  assert.equal(content.assets[0].path, "assets/subtitle.vtt");
});

test("keeps original media and records concrete missing dependencies for bad subtitles", async (t) => {
  const enrichment = await import("../src/content-enrichment.js");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "content-enrichment-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, "assets"));
  await fs.writeFile(path.join(directory, "assets", "video.mp4"), "small-media-sample");
  await fs.writeFile(path.join(directory, "assets", "bad.srt"), "\n\n");
  const content = await enrichment.enrichContent(record([
    { id: "video-1", role: "video", status: "saved", path: "assets/video.mp4", provenance: "original", partId: "p1" },
    { id: "bad-sub", role: "subtitle", status: "saved", path: "assets/bad.srt", provenance: "platform_subtitle", partId: "p1" }
  ]), { runtimeRoot: path.join(directory, "no-tools"), directory });
  assert.equal(content.assets[0].status, "saved");
  assert.equal(content.assets[0].path, "assets/video.mp4");
  assert.ok(content.assets.some((asset: { role: string; status: string; reason?: string }) => asset.role === "transcript" && asset.status === "missing_dependency" && /ASR|faster-whisper/.test(asset.reason ?? "")));
});

test("rejects an asset path that escapes its content directory", async (t) => {
  const enrichment = await import("../src/content-enrichment.js");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "content-enrichment-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const content = await enrichment.enrichContent(record([{ id: "unsafe", role: "image", status: "saved", path: "../outside.png", provenance: "original" }]), { runtimeRoot: directory, directory });
  assert.equal(content.assets[0].status, "failed");
  assert.match(content.assets[0].reason ?? "", /目录/);
});

test("stops enrichment on cancellation while retaining an existing original", async (t) => {
  const enrichment = await import("../src/content-enrichment.js");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "content-enrichment-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, "assets"));
  await fs.writeFile(path.join(directory, "assets", "video.mp4"), "small-media-sample");
  const controller = new AbortController();
  controller.abort();
  const context: ContentContext = { runtimeRoot: directory, directory, signal: controller.signal };
  const content = await enrichment.enrichContent(record([{ id: "video", role: "video", status: "saved", path: "assets/video.mp4", provenance: "original", partId: "p1" }]), context);
  assert.equal(content.assets[0].status, "saved");
  assert.ok(content.warnings.some((warning: string) => /取消/.test(warning)));
});

test("marks OCR as failed when a helper returns invalid JSON instead of claiming blank text", async (t) => {
  const enrichment = await import("../src/content-enrichment.js");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "content-enrichment-"));
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "content-ocr-runtime-"));
  t.after(() => Promise.all([fs.rm(directory, { recursive: true, force: true }), fs.rm(runtimeRoot, { recursive: true, force: true })]));
  await fs.mkdir(path.join(directory, "assets")); await fs.writeFile(path.join(directory, "assets", "image.png"), "nonempty-local-image");
  await fs.mkdir(path.join(runtimeRoot, "scripts"));
  await fs.writeFile(path.join(runtimeRoot, "scripts", "ocr-content.ps1"), "param([switch]$Probe,[string]$InputPath,[string]$OutputPath)\nif ($Probe) { exit 0 }; [IO.File]::WriteAllText($OutputPath, 'not-json'); exit 0\n");
  const input = record([{ id: "image", role: "image", status: "saved", path: "assets/image.png", provenance: "original", partId: "p1" }]);
  input.kind = "gallery";
  const content = await enrichment.enrichContent(input, { runtimeRoot, directory });
  const ocr = content.assets.find((asset: { role: string }) => asset.role === "ocr");
  assert.equal(ocr?.status, "failed");
  assert.match(ocr?.reason ?? "", /JSON/);
});

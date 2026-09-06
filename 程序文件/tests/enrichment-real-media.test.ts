import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runContentTool } from "../src/content-tools.js";
import { enrichContent } from "../src/content-enrichment.js";
import { saveContent } from "../src/content-library.js";
import type { CapturedContent } from "../src/content-types.js";

test("Windows OCR processes a real local PNG and records a blank result explicitly", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows.Media.Ocr is Windows-only");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "content-real-media-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "blank.png");
  const output = path.join(directory, "ocr.json");
  // A valid, one-pixel transparent PNG. It has no visible text, so blank is a successful OCR outcome.
  await fs.writeFile(input, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL+XQAAAABJRU5ErkJggg==", "base64"));
  const result = await runContentTool({ command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(process.cwd(), "scripts", "ocr-content.ps1"), "-InputPath", input, "-OutputPath", output], timeoutMs: 90_000 });
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(await fs.readFile(output, "utf8"));
  assert.equal(payload.status, "blank");
});

test("local video, known-text image, and offline speech pass through the real enrichment tools", async (t) => {
  if (process.platform !== "win32") return t.skip("local validation fixtures are Windows-only");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "content-real-chain-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const created = await runContentTool({ command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(process.cwd(), "tests", "enrichment-real-validation.ps1"), "-Directory", directory], timeoutMs: 90_000 });
  assert.equal(created.code, 0, created.stderr);
  const input: CapturedContent = { platform: "web", sourceUrl: "https://example.test/real", canonicalUrl: "https://example.test/real", title: "真实媒体链路", capturedAt: new Date().toISOString(), kind: "video", markdown: "", warnings: [], assets: [
    { id: "real-video", role: "video", status: "saved", path: "assets/sample.mp4", provenance: "original", partId: "p1" },
    { id: "real-image", role: "image", status: "saved", path: "assets/known-text.png", provenance: "original", partId: "p1" }
  ], parts: [{ id: "p1", title: "验证段", status: "saved", durationSeconds: 3 }] };
  const enriched = await enrichContent(input, { runtimeRoot: process.cwd(), directory });
  const audio = enriched.assets.find((asset) => asset.id.startsWith("audio-") && asset.status === "saved");
  const frame = enriched.assets.find((asset) => asset.role === "frame" && asset.status === "saved");
  const ocr = enriched.assets.find((asset) => asset.id.startsWith("ocr-") && asset.status === "saved");
  const asr = enriched.assets.find((asset) => asset.id.startsWith("transcript-asr-") && asset.status === "saved");
  assert.ok(audio?.path, JSON.stringify(enriched.assets)); assert.ok(frame?.path); assert.ok(ocr?.path); assert.ok(asr?.path);
  assert.match(await fs.readFile(path.join(directory, ocr.path!), "utf8"), /中\s*文\s*OCR\s*验\s*证/);
  assert.match(await fs.readFile(path.join(directory, asr.path!), "utf8"), /机器语音转写[\s\S]*fellow Americans/i);
  assert.match(enriched.coverage?.["frames:real-video"] ?? "", /已保存/);
});

test("a covering platform subtitle creates the reading transcript and completes without machine ASR", async (t) => {
  if (process.platform !== "win32") return t.skip("local validation fixtures are Windows-only");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "content-platform-subtitle-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const created = await runContentTool({ command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(process.cwd(), "tests", "enrichment-real-validation.ps1"), "-Directory", directory], timeoutMs: 90_000 });
  assert.equal(created.code, 0, created.stderr);
  await fs.writeFile(path.join(directory, "assets", "platform.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:01.500\n平台字幕第一句\n\n00:00:01.500 --> 00:00:03.000\n平台字幕第二句\n");
  const input: CapturedContent = { platform: "web", sourceUrl: "https://example.test/platform-subtitle", canonicalUrl: "https://example.test/platform-subtitle", title: "平台字幕验证", capturedAt: new Date().toISOString(), kind: "video", markdown: "", warnings: [], assets: [
    { id: "subtitle-video", role: "video", status: "saved", path: "assets/sample.mp4", provenance: "original", partId: "p1" },
    { id: "platform-subtitle", role: "subtitle", status: "saved", path: "assets/platform.vtt", provenance: "platform_subtitle", language: "zh", partId: "p1" }
  ], parts: [{ id: "p1", title: "验证段", status: "saved", durationSeconds: 3 }] };
  const enriched = await enrichContent(input, { runtimeRoot: process.cwd(), directory });
  const transcript = enriched.assets.find((asset) => asset.role === "transcript" && asset.provenance === "platform_subtitle" && asset.status === "saved");
  assert.ok(transcript?.path, JSON.stringify(enriched.assets));
  assert.equal(enriched.assets.some((asset) => asset.provenance === "machine_asr"), false);
  assert.match(enriched.coverage?.["subtitle:p1"] ?? "", /有效且覆盖/);
  const saved = await saveContent(path.join(directory, "library"), enriched, directory);
  assert.equal(saved.status, "completed", JSON.stringify(saved.assets));
  assert.match(await fs.readFile(path.join(directory, transcript.path!), "utf8"), /平台字幕第一句/);
});

test("a real video with no audio stream records unavailable audio and ASR while retaining frame OCR", async (t) => {
  if (process.platform !== "win32") return t.skip("local validation fixtures are Windows-only");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "content-no-audio-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, "assets"));
  const created = await runContentTool({ command: path.join(process.cwd(), "tools", "ffmpeg.exe"), args: ["-nostdin", "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=1", "-c:v", "libx264", "-an", path.join(directory, "assets", "no-audio.mp4")], timeoutMs: 30_000 });
  assert.equal(created.code, 0, created.stderr);
  const input: CapturedContent = { platform: "web", sourceUrl: "https://example.test/no-audio", canonicalUrl: "https://example.test/no-audio", title: "无音轨验证", capturedAt: new Date().toISOString(), kind: "video", markdown: "正文", warnings: [], assets: [
    { id: "silent-video", role: "video", status: "saved", path: "assets/no-audio.mp4", provenance: "original", partId: "p1" }
  ], parts: [{ id: "p1", title: "无音轨段", status: "saved", durationSeconds: 1 }] };
  const enriched = await enrichContent(input, { runtimeRoot: process.cwd(), directory });
  const audio = enriched.assets.find((asset) => asset.id.startsWith("audio-silent-video"));
  const transcript = enriched.assets.find((asset) => asset.id.startsWith("transcript-asr-silent-video"));
  assert.equal(audio?.status, "unavailable");
  assert.equal(transcript?.status, "unavailable");
  assert.match(audio?.reason ?? "", /原视频没有音轨/);
  assert.match(transcript?.reason ?? "", /原视频没有音轨/);
  assert.equal(enriched.assets.some((asset) => asset.provenance === "machine_asr" && asset.status === "saved"), false);
  assert.ok(enriched.assets.some((asset) => asset.role === "frame" && asset.status === "saved"));
  assert.ok(enriched.assets.some((asset) => asset.role === "ocr" && asset.status === "saved"));
});

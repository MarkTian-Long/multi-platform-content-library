import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CapturedContent, ContentContext } from "../src/content-types.js";
import { runContentTool } from "../src/content-tools.js";

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

async function runAsrFixture(t: TestContext, segments: unknown[], extraArgs: string[] = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "content-asr-fixture-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "input.media"), "local-test-media");
  await fs.mkdir(path.join(directory, "model"));
  await fs.writeFile(path.join(directory, "faster_whisper.py"), [
    "import json, os",
    "from types import SimpleNamespace",
    "__version__ = 'test-local'",
    "class WhisperModel:",
    "    def __init__(self, model, local_files_only=False, **options):",
    "        assert local_files_only, 'ASR must stay offline'",
    "        self.model = SimpleNamespace(device=options.get('device', 'auto'), compute_type=options.get('compute_type', 'default'))",
    "    def transcribe(self, source, **kwargs):",
    "        expected = os.environ.get('ASR_FIXTURE_EXPECTED_HOTWORDS')",
    "        if expected: assert kwargs.get('hotwords') == expected, 'explicit hints must reach local decoder'",
    "        raw = json.loads(os.environ['ASR_FIXTURE_SEGMENTS'])",
    "        for item in raw:",
    "            item['words'] = [SimpleNamespace(**word) for word in item.get('words', [])]",
    "        return iter(SimpleNamespace(**item) for item in raw), SimpleNamespace(language='zh', duration=2.0)",
    ""
  ].join("\n"));
  const localPython = path.join(process.cwd(), ".venv-content", "Scripts", "python.exe");
  const python = process.env.CONTENT_PYTHON_PATH || (await fs.stat(localPython).then(s => s.isFile()).catch(() => false) ? localPython : "python");
  const output = path.join(directory, "transcript");
  const hintsIndex = extraArgs.indexOf("--hotwords");
  const run = await runContentTool({ command: python, args: [path.join(process.cwd(), "scripts", "transcribe-content.py"), "--input", path.join(directory, "input.media"), "--model", path.join(directory, "model"), "--output-json", output + ".json", "--output-srt", output + ".srt", "--output-md", output + ".md", ...extraArgs], env: { ...process.env, PYTHONPATH: directory, PYTHONUTF8: "1", ASR_FIXTURE_SEGMENTS: JSON.stringify(segments), ...(hintsIndex >= 0 ? { ASR_FIXTURE_EXPECTED_HOTWORDS: extraArgs[hintsIndex + 1] } : {}) }, timeoutMs: 15000 });
  return { run, output };
}

test("local ASR clips a model timestamp to media duration and preserves uncertainty without rewriting words", async (t) => {
  const { run, output } = await runAsrFixture(t, [{ start: 0, end: 2.6, text: "善死", avg_logprob: -0.8, no_speech_prob: 0.02, words: [{ start: 0, end: 2.6, word: "善死", probability: 0.31 }] }]);
  assert.equal(run.code, 0, run.stderr);
  const data = JSON.parse(await fs.readFile(output + ".json", "utf8"));
  assert.equal(data.segments[0].endMs, 2000);
  assert.equal(data.segments[0].text, "善死");
  assert.equal(data.provenance, "machine_asr");
  assert.equal(data.language, "zh");
  assert.equal(data.segments[0].words[0].probability, 0.31);
  assert.ok(data.timestampAdjustments.length > 0);
  assert.match(await fs.readFile(output + ".srt", "utf8"), /00:00:02,000/);
});

test("local ASR with no recognized speech cannot leave a heading-only saved transcript", async (t) => {
  const { run, output } = await runAsrFixture(t, []);
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /no non-empty speech/i);
  assert.equal(await fs.stat(output + ".md").then(() => true).catch(() => false), false);
});

test("local ASR rejects an out-of-order timeline before writing transcript outputs", async (t) => {
  const { run, output } = await runAsrFixture(t, [{ start: 1.0, end: 1.5, text: "后句" }, { start: 0, end: 0.5, text: "前句" }]);
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /ordered/i);
  assert.equal(await fs.stat(output + ".json").then(() => true).catch(() => false), false);
});

test("local ASR accepts explicit CPU int8 without changing the default compute setting", async (t) => {
  const segments = [{ start: 0, end: 1, text: "本地对照", words: [] }];
  const baseline = await runAsrFixture(t, segments);
  assert.equal(baseline.run.code, 0, baseline.run.stderr);
  const ordinary = JSON.parse(await fs.readFile(baseline.output + ".json", "utf8"));
  assert.equal(ordinary.computeType, "default");
  assert.equal(ordinary.device, "auto");
  const explicit = await runAsrFixture(t, segments, ["--device", "cpu", "--compute-type", "int8"]);
  assert.equal(explicit.run.code, 0, explicit.run.stderr);
  const quantized = JSON.parse(await fs.readFile(explicit.output + ".json", "utf8"));
  assert.equal(quantized.computeType, "int8");
  assert.equal(quantized.device, "cpu");
});

test("local ASR records explicit vocabulary hints while preserving the recognized text", async (t) => {
  const hints = "SaaS, Adobe";
  const { run, output } = await runAsrFixture(t, [{ start: 0, end: 1, text: "SARS", words: [] }], ["--hotwords", hints]);
  assert.equal(run.code, 0, run.stderr);
  const data = JSON.parse(await fs.readFile(output + ".json", "utf8"));
  assert.equal(data.hotwords, hints);
  assert.equal(data.segments[0].text, "SARS");
  assert.match(await fs.readFile(output + ".md", "utf8"), /识别提示：SaaS, Adobe/);
});

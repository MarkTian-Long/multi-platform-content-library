import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promises as dns } from "node:dns";
import { acquireYoutube, type YoutubePlatformDeps } from "../src/content-ytdlp-platform.js";
import type { ContentContext, ContentInput } from "../src/content-types.js";
import type { ContentToolRunResult } from "../src/content-tools.js";
import { runLinkCli } from "../src/link-cli.js";
import { assetAction } from "../src/content-processing.js";
import { contentStatus } from "../src/content-library.js";

const input: ContentInput = { platform: "youtube", url: "https://youtu.be/abcdefghijk?si=tracking", nativeId: "abcdefghijk", canonicalUrl: "https://www.youtube.com/watch?v=abcdefghijk" };
const mediaUrl = "https://media.example.com/video.mp4?signature=test-only";
const metadata = { id: "abcdefghijk", extractor_key: "Youtube", title: "示例视频", uploader: "示例作者", description: "原始说明", duration: 120, webpage_url: input.canonicalUrl, formats: [{ format_id: "18", ext: "mp4", protocol: "https", url: mediaUrl, vcodec: "avc1", acodec: "mp4a", height: 360, filesize: 8 }] };
const result = (stdout = "", extra: Partial<ContentToolRunResult> = {}): ContentToolRunResult => ({ code: 0, stdout, stderr: "", timedOut: false, cancelled: false, outputTruncated: false, ...extra });

async function context(t: TestContext): Promise<ContentContext> {
  // Deterministic fixtures do not inherit the real machine's optional proxy.
  for (const key of ["CONTENT_YOUTUBE_PROXY", "HTTPS_PROXY", "HTTP_PROXY"]) {
    const prior = process.env[key]; delete process.env[key];
    t.after(() => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; });
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-platform-"));
  t.after(async () => { const target = path.resolve(directory); if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("youtube-platform-")) throw new Error("unexpected fixture path"); await fs.rm(target, { recursive: true, force: true }); });
  const runtimeRoot = path.join(directory, "runtime"); await fs.mkdir(path.join(runtimeRoot, "tools"), { recursive: true });
  for (const file of ["yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe"]) await fs.writeFile(path.join(runtimeRoot, "tools", file), "fixture-only");
  return { directory, runtimeRoot };
}

function fixtures(t: TestContext, overrides: Partial<typeof metadata> = {}) {
  const requests: string[] = []; const calls: { command: string; args: string[]; context: ContentContext }[] = [];
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  t.mock.method(globalThis, "fetch", async (url: URL) => { requests.push(url.toString()); return new Response("abcdefgh", { headers: { "content-type": "video/mp4", "content-length": "8" } }); });
  const deps: YoutubePlatformDeps = {
    runTool: async (command, args, current) => {
      calls.push({ command, args, context: current });
      if (args.includes("--dump-single-json")) return result(JSON.stringify({ ...metadata, ...overrides }));
      if (path.basename(command).startsWith("ffmpeg")) { await fs.writeFile(args.at(-1)!, "abcdefgh"); return result(); }
      return result(JSON.stringify({ streams: [{ codec_type: "video" }, { codec_type: "audio" }], format: { duration: "120" } }));
    },
    probeMedia: async () => ({ video: true, audio: true, durationSeconds: 120 }),
  };
  return { deps, requests, calls };
}

test("YouTube: a single progressive MP4 uses hardened metadata extraction and the public media downloader", async t => {
  const current = await context(t); const { deps, calls, requests } = fixtures(t);
  const content = await acquireYoutube(input, current, deps);
  const video = content.assets.find(asset => asset.role === "video" && asset.status === "saved");
  assert(video?.path, JSON.stringify(content)); assert.equal(content.platform, "youtube"); assert.equal(content.nativeId, input.nativeId);
  assert.equal(content.markdown, "原始说明"); assert.equal(content.author, "示例作者"); assert.equal(video.bytes, 8); assert.equal(video.sha256?.length, 64);
  assert.deepEqual(requests, [mediaUrl]); assert.equal(await fs.readFile(path.join(current.directory, video.path), "utf8"), "abcdefgh");
  const args = calls.find(call => call.args.includes("--dump-single-json"))!.args;
  for (const flag of ["--ignore-config", "--no-plugin-dirs", "--no-remote-components", "--no-playlist", "--skip-download", "--no-check-formats", "--no-js-runtimes", "--js-runtimes"]) assert(args.includes(flag), flag);
  assert.equal(args.at(-1), input.canonicalUrl); assert(!args.includes("--cookies-from-browser")); assert(!args.includes("--cookies")); assert(!args.includes("--write-info-json"));
  assert(!JSON.stringify(content).includes("signature=test-only"));
});

test("YouTube: separated MP4 and M4A use two public downloads and a local-only verified merge", async t => {
  const current = await context(t); const { deps, calls, requests } = fixtures(t, { formats: [
    { ...metadata.formats[0], format_id: "137", height: 1080, acodec: "none" },
    { ...metadata.formats[0], format_id: "140", ext: "m4a", url: "https://media.example.com/audio.m4a", vcodec: "none", height: 0 },
  ] });
  const content = await acquireYoutube(input, current, deps); const video = content.assets.find(asset => asset.role === "video" && asset.status === "saved");
  assert(video?.path, JSON.stringify(content)); assert.equal(requests.length, 2);
  const merge = calls.find(call => path.basename(call.command).startsWith("ffmpeg")); assert(merge); assert.equal(merge.args[merge.args.indexOf("-protocol_whitelist") + 1], "file,pipe");
  assert.equal(merge.args[merge.args.indexOf("-c") + 1], "copy"); assert(merge.args.includes("-fs")); assert(merge.args.every(arg => !/^https?:/.test(arg)));
});

test("YouTube: playlists, ID mismatch and other extractors never trigger a media request", async t => {
  const current = await context(t);
  for (const change of [{ _type: "playlist", entries: [] }, { id: "ABCDEFGHIJK" }, { extractor_key: "Generic" }]) {
    const { deps, requests } = fixtures(t, change as Partial<typeof metadata>);
    const content = await acquireYoutube(input, current, deps); assert(!content.assets.some(asset => asset.role === "video" && asset.status === "saved")); assert.equal(requests.length, 0);
  }
});

test("YouTube: live, DRM and fragment-based formats are unavailable rather than downloaded", async t => {
  const current = await context(t);
  for (const change of [{ is_live: true }, { formats: [{ ...metadata.formats[0], has_drm: true }] }, { formats: [{ ...metadata.formats[0], protocol: "m3u8_native", fragments: [{ url: mediaUrl }] }] }]) {
    const { deps, requests } = fixtures(t, change as Partial<typeof metadata>);
    const content = await acquireYoutube(input, current, deps); assert(!content.assets.some(asset => asset.role === "video" && asset.status === "saved")); assert.equal(requests.length, 0);
  }
});

test("YouTube: bot/login errors are explicit and never read a default browser profile", async t => {
  const current = await context(t); const { deps, requests } = fixtures(t); deps.runTool = async () => result("", { code: 1, stderr: "Sign in to confirm you’re not a bot. Use cookies-from-browser." });
  const content = await acquireYoutube(input, current, deps); assert(content.assets.some(asset => asset.status === "login_required")); assert.equal(requests.length, 0);
});

test("YouTube: a failed merge cannot replace a previous good video", async t => {
  const current = await context(t); await fs.mkdir(path.join(current.directory, "media")); await fs.writeFile(path.join(current.directory, "media/abcdefghijk.mp4"), "previous-good-file");
  const { deps } = fixtures(t, { formats: [{ ...metadata.formats[0], acodec: "none" }, { ...metadata.formats[0], url: "https://media.example.com/audio.m4a", ext: "m4a", vcodec: "none" }] });
  const run = deps.runTool!; deps.runTool = async (command, args, current) => path.basename(command).startsWith("ffmpeg") ? result("", { code: 1, stderr: "merge failed" }) : run(command, args, current);
  const content = await acquireYoutube(input, current, deps); assert(!content.assets.some(asset => asset.role === "video" && asset.status === "saved"));
  assert.equal(await fs.readFile(path.join(current.directory, "media/abcdefghijk.mp4"), "utf8"), "previous-good-file");
});

test("YouTube: probe duration mismatch prevents a saved video", async t => {
  const current = await context(t); const { deps } = fixtures(t); deps.probeMedia = async () => ({ video: true, audio: true, durationSeconds: 12 });
  const content = await acquireYoutube(input, current, deps); assert(!content.assets.some(asset => asset.role === "video" && asset.status === "saved")); assert.match(content.assets.find(asset => asset.role === "video")?.reason ?? "", /时长/);
});

test("YouTube: unknown duration and known media size above the cap fail before transmission", async t => {
  const current = await context(t);
  for (const change of [{ duration: 0 }, { formats: [{ ...metadata.formats[0], filesize: 2 * 1024 * 1024 * 1024 + 1 }] }]) {
    const { deps, requests } = fixtures(t, change); const content = await acquireYoutube(input, current, deps);
    assert(!content.assets.some(asset => asset.role === "video" && asset.status === "saved")); assert.equal(requests.length, 0);
  }
});

test("YouTube: caller cancellation stops before metadata or media requests", async t => {
  const current = await context(t); const controller = new AbortController(); controller.abort(); current.signal = controller.signal;
  const { deps, calls, requests } = fixtures(t); const content = await acquireYoutube(input, current, deps);
  assert(!content.assets.some(asset => asset.role === "video" && asset.status === "saved")); assert.equal(calls.length, 0); assert.equal(requests.length, 0);
});

test("YouTube: external, playlist-only and credentialed inputs never call yt-dlp", async t => {
  const current = await context(t);
  for (const url of ["https://other.example/watch?v=abcdefghijk", "https://youtube.com/playlist?list=PL-example", "https://user:secret@youtube.com/watch?v=abcdefghijk"]) {
    const { deps, calls, requests } = fixtures(t); const content = await acquireYoutube({ ...input, url }, current, deps);
    assert(!content.assets.some(asset => asset.role === "video" && asset.status === "saved")); assert.equal(calls.length, 0); assert.equal(requests.length, 0);
  }
});

test("YouTube: only the existing dedicated YouTube cookie file is passed to metadata extraction", async t => {
  const current = await context(t); const profile = path.join(current.runtimeRoot, ".content-profile/youtube"); await fs.mkdir(profile, { recursive: true });
  const cookieFile = path.join(profile, "cookies.txt"); await fs.writeFile(cookieFile, "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\ttest-only\tfixture\n");
  const { deps, calls } = fixtures(t); const content = await acquireYoutube(input, current, deps);
  assert(content.assets.some(asset => asset.role === "video" && asset.status === "saved"));
  const args = calls.find(call => call.args.includes("--dump-single-json"))!.args;
  assert.equal(args[args.indexOf("--cookies") + 1], cookieFile); assert(!args.includes("--cookies-from-browser"));
});

test("YouTube: a symbolic dedicated profile cannot expose another browser cookie file", async t => {
  const current = await context(t); const outside = path.join(current.directory, "browser-fixture"); await fs.mkdir(outside); await fs.writeFile(path.join(outside, "cookies.txt"), "test-only-cookie-file");
  const parent = path.join(current.runtimeRoot, ".content-profile"); await fs.mkdir(parent); await fs.symlink(outside, path.join(parent, "youtube"), process.platform === "win32" ? "junction" : "dir");
  const { deps, calls, requests } = fixtures(t); const content = await acquireYoutube(input, current, deps);
  assert(!content.assets.some(asset => asset.status === "saved")); assert.equal(calls.length, 0); assert.equal(requests.length, 0);
});

test("YouTube: private media targets are rejected before any media request", async t => {
  const current = await context(t); const { deps, requests } = fixtures(t, { formats: [{ ...metadata.formats[0], url: "http://127.0.0.1/secret.mp4" }] });
  const content = await acquireYoutube(input, current, deps); assert(!content.assets.some(asset => asset.status === "saved")); assert.match(content.warnings.join(" "), /私网/); assert.equal(requests.length, 0);
});

test("YouTube: transport truncation never reaches the video probe or saved state", async t => {
  const current = await context(t); const { deps, requests } = fixtures(t); let probes = 0;
  t.mock.method(globalThis, "fetch", async (url: URL) => { requests.push(url.toString()); return new Response("abcdefgh", { headers: { "content-type": "video/mp4", "content-length": "12" } }); });
  deps.probeMedia = async () => { probes++; return { video: true, audio: true, durationSeconds: 120 }; };
  const content = await acquireYoutube(input, current, deps); assert(!content.assets.some(asset => asset.status === "saved")); assert.equal(requests.length, 3); assert.equal(probes, 0);
});

test("YouTube: cancellation during a stalled body cleans the transaction and preserves the previous video", async t => {
  const current = await context(t); await fs.mkdir(path.join(current.directory, "media")); await fs.writeFile(path.join(current.directory, "media/abcdefghijk.mp4"), "previous-good-file");
  const controller = new AbortController(); current.signal = controller.signal; const { deps, requests } = fixtures(t);
  t.mock.method(globalThis, "fetch", async (url: URL) => { requests.push(url.toString()); return new Response(new ReadableStream({ start(stream) { stream.enqueue(Buffer.from("abcd")); } }), { headers: { "content-type": "video/mp4", "content-length": "8" } }); });
  const timer = setTimeout(() => controller.abort(), 40); t.after(() => clearTimeout(timer));
  const content = await acquireYoutube(input, current, deps); assert(!content.assets.some(asset => asset.status === "saved")); assert.match(content.warnings.join(" "), /取消/);
  assert.equal(await fs.readFile(path.join(current.directory, "media/abcdefghijk.mp4"), "utf8"), "previous-good-file");
  assert.deepEqual(await fs.readdir(path.join(current.directory, ".youtube-downloads")), []);
});

test("YouTube: known aggregate split-stream size above 2 GiB prevents both downloads", async t => {
  const current = await context(t); const { deps, requests } = fixtures(t, { formats: [
    { ...metadata.formats[0], acodec: "none", filesize: 1536 * 1024 * 1024 },
    { ...metadata.formats[0], vcodec: "none", ext: "m4a", filesize: 1536 * 1024 * 1024 },
  ] });
  const content = await acquireYoutube(input, current, deps); assert(!content.assets.some(asset => asset.status === "saved")); assert.match(content.warnings.join(" "), /上限/); assert.equal(requests.length, 0);
});

test("YouTube: failed or unparseable metadata cannot proceed to media", async t => {
  const current = await context(t);
  for (const output of [result("not-json"), result(JSON.stringify(metadata), { outputTruncated: true }), result("", { timedOut: true, code: 130 })]) {
    const { deps, requests } = fixtures(t); deps.runTool = async () => output;
    const content = await acquireYoutube(input, current, deps); assert(!content.assets.some(asset => asset.status === "saved")); assert.equal(requests.length, 0);
  }
});

test("YouTube: missing verified video or audio streams cannot be marked saved", async t => {
  const current = await context(t);
  for (const probe of [undefined, { video: true, audio: false, durationSeconds: 120 }, { video: true, audio: true }]) {
    const { deps } = fixtures(t); deps.probeMedia = async () => probe;
    const content = await acquireYoutube(input, current, deps); assert(!content.assets.some(asset => asset.status === "saved"));
  }
});

test("YouTube: a severely shortened two-second video fails the duration integrity check", async t => {
  const current = await context(t); const { deps } = fixtures(t, { duration: 2 });
  deps.probeMedia = async () => ({ video: true, audio: true, durationSeconds: 0.2 });
  const content = await acquireYoutube(input, current, deps); assert(!content.assets.some(asset => asset.status === "saved")); assert.match(content.warnings.join(" "), /时长/);
});

test("YouTube: metadata and media use the same explicit existing proxy", async t => {
  const current = await context(t); process.env.CONTENT_YOUTUBE_PROXY = "http://127.0.0.1:7897";
  const { deps, calls } = fixtures(t); let transfers = 0;
  deps.mediaTransport = async (_url, init, signal) => {
    transfers++; assert.equal(init?.headers && new Headers(init.headers).get("accept-encoding"), "identity"); assert(signal);
    return new Response("abcdefgh", { headers: { "content-type": "video/mp4", "content-length": "8" } });
  };
  const content = await acquireYoutube(input, current, deps);
  assert(content.assets.some(asset => asset.status === "saved")); assert.equal(transfers, 1);
  const args = calls.find(call => call.args.includes("--dump-single-json"))!.args;
  assert.equal(args[args.indexOf("--proxy") + 1], "http://127.0.0.1:7897/");
});

test("YouTube: unsupported or credentialed proxy cannot reach metadata", async t => {
  const current = await context(t);
  for (const value of ["http://name:password@127.0.0.1:7897", "http://remote.example.com:7897", "http://127.0.0.1:7897/private", "socks5://127.0.0.1:7897"]) {
    process.env.CONTENT_YOUTUBE_PROXY = value;
    const { deps, calls, requests } = fixtures(t); const content = await acquireYoutube(input, current, deps);
    assert(!content.assets.some(asset => asset.status === "saved")); assert.equal(calls.length, 0); assert.equal(requests.length, 0);
    assert(!JSON.stringify(content).includes("password"));
  }
});

test("YouTube: a metadata 429 is distinct from login and has no automatic retry", async t => {
  const current = await context(t); const { deps, requests, calls } = fixtures(t);
  const original = deps.runTool!;
  deps.runTool = async (command, args, ctx) => { await original(command, args, ctx); return result("", { code: 1, stderr: "HTTP Error 429: Too Many Requests\n" + "x".repeat(900) + "\nSign in to confirm you are not a bot. Use cookies." }); };
  const record = await acquireYoutube(input, current, deps);
  assert.equal(requests.length, 0); assert.equal(calls.length, 1); assert.equal(record.coverage?.access, "rate_limited");
  assert.equal(record.coverage?.failureStage, "metadata"); assert.match(record.warnings.join(" "), /429.*稍后/);
  const args = calls[0].args; assert.equal(args[args.indexOf("--retries") + 1], "0"); assert.equal(args[args.indexOf("--extractor-retries") + 1], "0");
  assert.match(assetAction(record.assets[0]), /稍后/); assert(!record.assets.some(asset => asset.status === "saved"));
});

test("YouTube: media 429 stops after one request and never publishes a partial video", async t => {
  const before=Date.now();
  const current = await context(t); const { deps } = fixtures(t); let requests = 0;
  deps.mediaTransport = async () => { requests++; return new Response("limited", { status: 429, headers: { "retry-after": "120" } }); };
  const record = await acquireYoutube(input, current, deps);
  assert.equal(requests, 1); assert.equal(record.coverage?.access, "rate_limited"); assert.equal(record.coverage?.failureStage, "media");
  assert.ok(Date.parse(record.coverage?.retryAfter??"")>=before+120000);
  assert.match(record.warnings.join(" "), /429.*稍后/); assert(!record.assets.some(asset => asset.status === "saved"));
  assert.deepEqual(await fs.readdir(path.join(current.directory, ".youtube-downloads")), []);
});

test("YouTube: saved network mode overrides inherited proxies and original mode completes without unsupported comments", async t => {
  const current = await context(t); process.env.HTTPS_PROXY = "http://127.0.0.1:7891";
  assert.equal((await runLinkCli(["youtube-network", "direct"], { runtimeRoot: current.runtimeRoot, root: current.directory })).ok, true);
  const { deps, calls } = fixtures(t); const record = await acquireYoutube(input, current, deps);
  const args = calls.find(call => call.args.includes("--dump-single-json"))!.args; assert.equal(args[args.indexOf("--proxy") + 1], "");
  assert.equal(contentStatus({ ...record, processingMode: "original" }), "completed");
  assert.match(record.coverage?.comments ?? "", /not_supported/); assert.match(record.coverage?.subtitles ?? "", /not_supported/);
});

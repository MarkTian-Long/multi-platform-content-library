import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promises as dns } from "node:dns";
import { acquireDouyin as acquireDouyinModule, type DouyinDeps } from "../src/content-douyin.js";
import { runContentTool } from "../src/content-tools.js";
import type { ContentInput, ContentContext } from "../src/content-types.js";
import {contentStatus} from "../src/content-library.js";

const id = "6961737553342991651";
const input = { platform: "douyin", nativeId: id, url: `https://www.douyin.com/video/${id}`, canonicalUrl: `https://www.douyin.com/video/${id}` } as ContentInput;
const mediaUrl = "https://media.example.com/clip.mp4?signature=fixture-only";
const work = { aweme_id: id, desc: "原始作品说明 #话题", author: { nickname: "示例作者" }, create_time: 1620905839, video: { duration: 19000, play_addr: { url_list: [mediaUrl] } } };
const page = (value: unknown) => `<script id="RENDER_DATA" type="application/json">${encodeURIComponent(JSON.stringify(value))}</script>`;
const state = (value: unknown) => page({ aweme: { detail: value } });
// Existing non-browser cases use a closed injected boundary; adding automatic
// fallback must never launch a real shared profile during these unit checks.
const acquireDouyin = (input: ContentInput, current: ContentContext, deps: DouyinDeps = {}) => acquireDouyinModule(input, current, {
  captureBrowser: async () => { throw new Error("closed browser fixture"); },
  runTool: async () => ({ code: 1, stdout: "", stderr: "metadata fixture unavailable", cancelled: false, timedOut: false, outputTruncated: false }),
  ...deps,
});

async function context(t: TestContext): Promise<ContentContext> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-adapter-"));
  t.after(async () => { const target = path.resolve(directory); if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("douyin-adapter-")) throw new Error("unexpected test root"); await fs.rm(target, { recursive: true, force: true }); });
  const runtimeRoot = path.join(directory, "runtime"); await fs.mkdir(path.join(runtimeRoot, "tools"), { recursive: true });
  await fs.writeFile(path.join(runtimeRoot, "tools/yt-dlp.exe"), "fixture-only");
  return { directory, runtimeRoot };
}

function transport(t: TestContext, html = state(work)) {
  const calls: { url: string; headers: Headers }[] = [];
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(options.headers) });
    return String(url).startsWith("https://www.douyin.com/") ? new Response(html, { headers: { "content-type": "text/html" } }) : new Response("abcdefgh", { headers: { "content-type": "video/mp4", "content-length": "8" } });
  });
  return calls;
}
const probe: DouyinDeps["probeMedia"] = async () => ({ video: true, audio: true, durationSeconds: 19 });

test("Douyin: original mode completes without unsupported native comments or subtitles",async t=>{
  const current=await context(t);transport(t);const record=await acquireDouyin(input,current,{probeMedia:probe});
  assert.equal(contentStatus({...record,processingMode:"original"}),"completed");
  assert.match(record.coverage?.comments??"",/not_supported/);assert.match(record.coverage?.subtitles??"",/not_supported/);
  assert.equal(contentStatus({...record,processingMode:"full"}),"partial","requested local derivatives still need processing");
});

test("Douyin: exact public work state preserves description and saves only its verified original video", async t => {
  const current = await context(t); const calls = transport(t); const content = await acquireDouyin(input, current, { probeMedia: probe });
  const video = content.assets.find(asset => asset.role === "video" && asset.status === "saved"); assert(video?.path, JSON.stringify(content));
  assert.equal(content.nativeId, id); assert.equal(content.markdown, work.desc); assert.equal(content.author, "示例作者"); assert.equal(video.bytes, 8); assert.equal(video.sha256?.length, 64);
  assert.deepEqual(calls.map(call => call.url), [input.url, mediaUrl]); assert(!JSON.stringify(content).includes("fixture-only"));
  assert.equal(await fs.readFile(path.join(current.directory, video.path), "utf8"), "abcdefgh");
});

test("Douyin: router state selects the requested work, not a recommendation", async t => {
  const current = await context(t); const html = `<script>window._ROUTER_DATA=${JSON.stringify({ loaderData: { "video_(id)/page": { videoInfoRes: { item_list: [{ ...work, aweme_id: "6982497745948921092", video: { duration: 19000, play_addr: { url_list: ["https://media.example.com/recommendation.mp4"] } } }, work] } } } })};</script>`;
  const calls = transport(t, html); const content = await acquireDouyin(input, current, { probeMedia: probe });
  assert(content.assets.some(asset => asset.status === "saved")); assert.equal(calls.length, 2); assert(!calls.some(call => call.url.includes("recommendation.mp4")));
});

test("Douyin: mismatched state and metadata are never accepted as the submitted work", async t => {
  const current = await context(t); const calls = transport(t, state({ ...work, aweme_id: "6982497745948921092" }));
  const content = await acquireDouyin(input, current, { probeMedia: probe, runTool: async () => ({ code: 0, stdout: JSON.stringify({ id: "6982497745948921092", extractor_key: "Douyin", duration: 19, formats: [] }), stderr: "", cancelled: false, timedOut: false, outputTruncated: false }) });
  assert(!content.assets.some(asset => asset.status === "saved")); assert.equal(calls.length, 1); assert.match(content.warnings.join(" "), /身份|作品/);
});

test("Douyin: captcha stops before metadata fallback or media download", async t => {
  const current = await context(t); const calls = transport(t, "<title>安全验证</title><p>请完成滑块验证码</p>"); let tools = 0;
  const content = await acquireDouyin(input, current, { runTool: async () => { tools++; throw new Error("must not be reached"); }, probeMedia: probe });
  assert(content.assets.some(asset => asset.status === "login_required")); assert.equal(tools, 0); assert.equal(calls.length, 1);
});

test("Douyin: metadata-only fallback is restricted to Douyin and its exact ID", async t => {
  const current = await context(t); const calls = transport(t, "<html><title>抖音</title></html>"); let args: string[] = [];
  const content = await acquireDouyin(input, current, { probeMedia: probe, runTool: async (_command, passed) => { args = passed; return { code: 0, stdout: JSON.stringify({ id, extractor_key: "Douyin", title: "标题", description: work.desc, duration: 19, formats: [{ url: mediaUrl, ext: "mp4", protocol: "https", vcodec: "h264" }] }), stderr: "", cancelled: false, timedOut: false, outputTruncated: false }; } });
  assert(content.assets.some(asset => asset.status === "saved")); assert.equal(calls.length, 2);
  for (const flag of ["--ignore-config", "--no-plugin-dirs", "--no-playlist", "--skip-download", "--no-check-formats", "--dump-single-json"]) assert(args.includes(flag), flag);
  assert.equal(args[args.indexOf("--use-extractors") + 1], "^Douyin$"); assert.equal(args.at(-1), input.canonicalUrl); assert(!args.includes("--cookies-from-browser"));
});

test("Douyin: fresh-cookie failures return a session/verification state without a third-party request", async t => {
  const current = await context(t); const calls = transport(t, "<html>抖音</html>");
  const content = await acquireDouyin(input, current, { probeMedia: probe, runTool: async () => ({ code: 1, stdout: "", stderr: "Fresh cookies (not necessarily logged in) are needed", cancelled: false, timedOut: false, outputTruncated: false }) });
  assert(content.assets.some(asset => asset.status === "login_required")); assert.equal(calls.length, 1);
});

test("Douyin: only a dedicated unexpired domain cookie reaches the work page, never media", async t => {
  const current = await context(t); const profile = path.join(current.runtimeRoot, ".content-profile/douyin"); await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, "cookies.txt"), "# Netscape HTTP Cookie File\n.douyin.com\tTRUE\t/\tTRUE\t0\tvalid_fixture\tallowed\n.evil.example\tTRUE\t/\tTRUE\t0\tforeign_fixture\tforbidden\n.douyin.com\tTRUE\t/\tTRUE\t1\texpired_fixture\tforbidden\ndouyin.com\tFALSE\t/\tTRUE\t0\thost_only_fixture\tforbidden\n.douyin.com\tTRUE\t/aweme/\tTRUE\t0\tother_path_fixture\tforbidden\n");
  const calls = transport(t); const content = await acquireDouyin(input, current, { probeMedia: probe }); assert(content.assets.some(asset => asset.status === "saved"));
  assert.equal(calls[0].headers.get("cookie"), "valid_fixture=allowed"); assert.equal(calls[1].headers.get("cookie"), null);
});

test("Douyin: private media, missing video stream and duration mismatch cannot replace a good file", async t => {
  const current = await context(t); await fs.mkdir(path.join(current.directory, "video")); await fs.writeFile(path.join(current.directory, "video/001.mp4"), "previous-good-file");
  for (const [changed, checked] of [[{ ...work, video: { duration: 19000, play_addr: { url_list: ["http://127.0.0.1/secret.mp4"] } } }, probe], [work, async () => ({ video: false, audio: true, durationSeconds: 19 })], [work, async () => ({ video: true, audio: true, durationSeconds: 1 })]] as const) {
    transport(t, state(changed)); const content = await acquireDouyin(input, current, { probeMedia: checked }); assert(!content.assets.some(asset => asset.status === "saved"));
    assert.equal(await fs.readFile(path.join(current.directory, "video/001.mp4"), "utf8"), "previous-good-file");
  }
});

test("Douyin: library budget and cancellation are enforced before saved state", async t => {
  const current = await context(t); const calls = transport(t);
  const limited = await acquireDouyin(input, current, { probeMedia: probe, maxVideoBytes: 4 }); assert(!limited.assets.some(asset => asset.status === "saved")); assert.match(limited.warnings.join(" "), /上限/);
  const controller = new AbortController(); controller.abort(); const before = calls.length;
  const cancelled = await acquireDouyin(input, { ...current, signal: controller.signal }, { probeMedia: probe }); assert(!cancelled.assets.some(asset => asset.status === "saved")); assert.equal(calls.length, before);
});

test("Douyin: target image posts retain their original text but do not claim video support", async t => {
  const current = await context(t); const calls = transport(t, state({ ...work, video: undefined, images: [{ display_image: { url_list: ["https://media.example.com/photo.jpg"] } }] }));
  const content = await acquireDouyin(input, current, { probeMedia: probe }); assert.equal(content.kind, "gallery"); assert.equal(content.markdown, work.desc);
  assert(!content.assets.some(asset => asset.status === "saved")); assert.equal(calls.length, 1); assert.match(content.warnings.join(" "), /图文|图片/);
});

test("Douyin: user pages, collections, live, duplicate identities and fake hosts are not work inputs", async t => {
  const current = await context(t); const calls = transport(t);
  for (const url of ["https://www.douyin.com/user/example", "https://www.douyin.com/collection/123", "https://live.douyin.com/123", `https://douyin.com.evil.example/video/${id}`, `https://www.douyin.com/video/${id}/extra`, `https://user:secret@www.douyin.com/video/${id}`]) {
    const content = await acquireDouyin({ ...input, url }, current, { probeMedia: probe }); assert(!content.assets.some(asset => asset.status === "saved"));
  }
  assert.equal(calls.length, 0);
});

test("Douyin: a legitimate work description mentioning captcha is not a verification page", async t => {
  const current = await context(t); const item = { ...work, desc: "讲解验证码与登录安全" };
  const html = `<title>讲解验证码与登录安全 - 抖音</title><script>window._ROUTER_DATA=${JSON.stringify({ loaderData: { "video_(id)/page": { videoInfoRes: { item_list: [item] } } } })};</script>`;
  transport(t, html); const content = await acquireDouyin(input, current, { probeMedia: probe });
  assert(content.assets.some(asset => asset.status === "saved")); assert.equal(content.markdown, item.desc);
});

test("Douyin: a symbolic profile cannot read another cookie file and stalled-body cancellation removes only its transaction", async t => {
  const current = await context(t); const parent = path.join(current.runtimeRoot, ".content-profile"); const outside = path.join(current.directory, "browser-fixture");
  await fs.mkdir(parent); await fs.mkdir(outside); await fs.writeFile(path.join(outside, "cookies.txt"), "test-only");
  const profile = path.join(parent, "douyin"); await fs.symlink(outside, profile, process.platform === "win32" ? "junction" : "dir");
  const calls = transport(t); const rejected = await acquireDouyin(input, current, { probeMedia: probe }); assert(!rejected.assets.some(asset => asset.status === "saved")); assert.equal(calls.length, 0);
  await fs.unlink(profile);
  await fs.mkdir(path.join(current.directory, "video")); await fs.writeFile(path.join(current.directory, "video/001.mp4"), "previous-good-file");
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (url: URL) => String(url).startsWith("https://www.douyin.com/") ? new Response(state(work)) : new Response(new ReadableStream({ start(stream) { stream.enqueue(Buffer.from("abcd")); } }), { headers: { "content-type": "video/mp4", "content-length": "8" } }));
  const timer = setTimeout(() => controller.abort(), 40); t.after(() => clearTimeout(timer));
  const cancelled = await acquireDouyin(input, { ...current, signal: controller.signal }, { probeMedia: probe }); assert(!cancelled.assets.some(asset => asset.status === "saved")); assert.match(cancelled.warnings.join(" "), /取消/);
  assert.equal(await fs.readFile(path.join(current.directory, "video/001.mp4"), "utf8"), "previous-good-file"); assert.deepEqual(await fs.readdir(path.join(current.directory, ".douyin-downloads")), []);
});

test("Douyin: exact usable target state takes precedence over normal login/verification text", async t => {
  const current = await context(t); const item = { ...work, desc: "请完成登录验证，这句话是本条作品的说明" };
  transport(t, `<title>登录 - 抖音</title><p>请完成登录验证的功能演示</p>${state(item)}`);
  const content = await acquireDouyin(input, current, { probeMedia: probe });
  assert(content.assets.some(asset => asset.role === "video" && asset.status === "saved")); assert.equal(content.markdown, item.desc);
});

test("Douyin: a metadata title remains a title when the original description is absent", async t => {
  const current = await context(t); transport(t, "<html><title>抖音</title></html>");
  const content = await acquireDouyin(input, current, { probeMedia: probe, runTool: async () => ({ code: 0, stdout: JSON.stringify({ id, extractor_key: "Douyin", title: "只有标题", duration: 19, formats: [{ url: mediaUrl, ext: "mp4", protocol: "https", vcodec: "h264" }] }), stderr: "", cancelled: false, timedOut: false, outputTruncated: false }) });
  assert(content.assets.some(asset => asset.role === "video" && asset.status === "saved")); assert.equal(content.title, "只有标题"); assert.equal(content.markdown, ""); assert.match(content.coverage?.body ?? "", /^unavailable/);
});

test("Douyin: default MP4 probing rejects a playlist payload instead of reading its local media reference", async t => {
  const current = await context(t); const projectRoot = path.resolve(".");
  const ffprobe = path.join(projectRoot, "tools", process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  const tinyVideo = path.join(projectRoot, "logs/platform-expansion-20261014/offline-merge/media/abcdefghijk.mp4");
  if (!await fs.stat(ffprobe).then(stat => stat.isFile(), () => false) || !await fs.stat(tinyVideo).then(stat => stat.isFile(), () => false)) { t.skip("local ffprobe and previously generated tiny fixture unavailable"); return; }
  const oldProbe = process.env.CONTENT_FFPROBE_PATH; process.env.CONTENT_FFPROBE_PATH = ffprobe;
  t.after(() => { if (oldProbe === undefined) delete process.env.CONTENT_FFPROBE_PATH; else process.env.CONTENT_FFPROBE_PATH = oldProbe; });
  const playlist = "ffconcat version 1.0\nfile 'tiny.mp4'\nduration 2\n";
  transport(t, state({ ...work, video: { ...work.video, duration: 2000 } }));
  t.mock.method(globalThis, "fetch", async (url: URL) => String(url).startsWith("https://www.douyin.com/") ? new Response(state({ ...work, video: { ...work.video, duration: 2000 } })) : new Response(playlist, { headers: { "content-type": "video/mp4", "content-length": String(Buffer.byteLength(playlist)) } }));
  const content = await acquireDouyin(input, current, { runTool: async (command, args, current) => {
    await fs.copyFile(tinyVideo, path.join(path.dirname(args.at(-1)!), "tiny.mp4"));
    return runContentTool({ command, args, cwd: current.directory, signal: current.signal, timeoutMs: 10000 });
  } });
  assert(!content.assets.some(asset => asset.role === "video" && asset.status === "saved"));
});

test("Douyin: default MOV probing still accepts a real local MP4 through the mocked transport", async t => {
  const current = await context(t); const projectRoot = path.resolve(".");
  const ffprobe = path.join(projectRoot, "tools", process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  const tinyVideo = path.join(projectRoot, "logs/platform-expansion-20261014/offline-merge/media/abcdefghijk.mp4");
  if (!await fs.stat(ffprobe).then(stat => stat.isFile(), () => false) || !await fs.stat(tinyVideo).then(stat => stat.isFile(), () => false)) { t.skip("local ffprobe and previously generated tiny fixture unavailable"); return; }
  const oldProbe = process.env.CONTENT_FFPROBE_PATH; process.env.CONTENT_FFPROBE_PATH = ffprobe;
  t.after(() => { if (oldProbe === undefined) delete process.env.CONTENT_FFPROBE_PATH; else process.env.CONTENT_FFPROBE_PATH = oldProbe; });
  const bytes = await fs.readFile(tinyVideo); transport(t);
  t.mock.method(globalThis, "fetch", async (url: URL) => String(url).startsWith("https://www.douyin.com/") ? new Response(state({ ...work, video: { ...work.video, duration: 2000 } })) : new Response(bytes, { headers: { "content-type": "video/mp4", "content-length": String(bytes.length) } }));
  const content = await acquireDouyin(input, current, { runTool: async (command, args, current) => runContentTool({ command, args, cwd: current.directory, signal: current.signal, timeoutMs: 10000 }) });
  const saved = content.assets.find(asset => asset.role === "video" && asset.status === "saved"); assert(saved); assert.equal(saved.bytes, bytes.length);
});

test("Douyin Edge: HTTP denial falls back to exact official detail JSON and one bounded request", async t => {
  const current = await context(t); const calls = transport(t);
  t.mock.method(globalThis, "fetch", async (url: URL) => { calls.push({ url: String(url), headers: new Headers() }); return String(url).startsWith("https://www.douyin.com/") ? new Response("blocked", { status: 403 }) : new Response("abcdefgh", { headers: { "content-type": "video/mp4", "content-length": "8" } }); });
  let captured = 0;
  const content = await acquireDouyin(input, current, { probeMedia: probe, captureBrowser: async (source, context, requests) => {
    captured++; assert.equal(source.nativeId, id); assert.equal(context.runtimeRoot, current.runtimeRoot); assert.equal(requests?.length, 1);
    const request = new URL(requests![0].url); assert.equal(request.origin, "https://www.douyin.com"); assert.equal(request.pathname, "/aweme/v1/web/aweme/detail/"); assert.equal(request.searchParams.get("aweme_id"), id);
    return { finalUrl: input.canonicalUrl, html: "<video src='https://media.example.com/unbound.mp4'></video>", responses: [{ url: request.toString(), data: { aweme_detail: work } }], gated: false };
  } });
  assert.equal(captured, 1); assert(content.assets.some(asset => asset.status === "saved")); assert.equal(content.markdown, work.desc); assert.equal(calls.length, 2);
});

test("Douyin Edge: an HTTP shell uses rendered exact state before a slow yt-dlp attempt", async t => {
  const current = await context(t); transport(t, "<html><title>抖音</title></html>"); let captured = 0;
  let tools = 0;
  const content = await acquireDouyin(input, current, { probeMedia: probe, runTool: async () => { tools++; throw new Error("yt-dlp must not run before a usable browser subject"); }, captureBrowser: async () => {
    captured++; return { finalUrl: input.canonicalUrl, html: state(work), responses: [], gated: false };
  } });
  assert.equal(captured, 1); assert.equal(tools, 0); assert(content.assets.some(asset => asset.status === "saved")); assert.equal(content.markdown, work.desc);
});

test("Douyin Edge: a known video missing its link is enriched without erasing successful text", async t => {
  const current = await context(t); transport(t, state({ ...work, video: { duration: 19000 } })); let captured = 0;
  const content = await acquireDouyin(input, current, { probeMedia: probe, captureBrowser: async () => {
    captured++; return { finalUrl: input.canonicalUrl, html: "", responses: [{ url: `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${id}`, data: { aweme_detail: { ...work, desc: undefined, author: undefined } } }], gated: false };
  } });
  assert.equal(captured, 1); assert(content.assets.some(asset => asset.status === "saved")); assert.equal(content.markdown, work.desc); assert.equal(content.author, work.author.nickname);
});

test("Douyin Edge: recommendation IDs, external JSON and unbound DOM video URLs are rejected", async t => {
  const current = await context(t);
  for (const [url, value] of [
    [`https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${id}`, { ...work, aweme_id: "6982497745948921092" }],
    [`https://evil.example/aweme/v1/web/aweme/detail/?aweme_id=${id}`, work],
    [`https://www.douyin.com/aweme/v1/web/feed/?aweme_id=${id}`, work],
    ["https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=6982497745948921092", work],
  ] as const) {
    const calls = transport(t); t.mock.method(globalThis, "fetch", async () => { calls.push({ url: input.url, headers: new Headers() }); return new Response("denied", { status: 403 }); });
    const content = await acquireDouyin(input, current, { probeMedia: probe, captureBrowser: async () => ({ finalUrl: input.canonicalUrl, html: `<meta property='og:title' content='抖音'><video src='${mediaUrl}'></video>`, responses: [{ url, data: { aweme_detail: value } }], gated: false }) });
    assert(!content.assets.some(asset => asset.status === "saved")); assert.equal(calls.length, 1);
  }
});

test("Douyin Edge: empty, wrong-page and gated results preserve exact previous text and old media", async t => {
  const current = await context(t); await fs.mkdir(path.join(current.directory, "video")); await fs.writeFile(path.join(current.directory, "video/001.mp4"), "previous-good-file");
  for (const browser of [
    { finalUrl: input.canonicalUrl, html: "", responses: [], gated: false },
    { finalUrl: "https://www.douyin.com/video/6982497745948921092", html: state(work), responses: [], gated: false },
    { finalUrl: input.canonicalUrl, html: "<title>安全验证</title><p>请完成滑块验证</p>", responses: [], gated: true },
  ]) {
    transport(t, state({ ...work, video: { duration: 19000 } }));
    const content = await acquireDouyin(input, current, { probeMedia: probe, captureBrowser: async () => browser });
    assert(!content.assets.some(asset => asset.status === "saved")); assert.equal(content.markdown, work.desc); assert.equal(await fs.readFile(path.join(current.directory, "video/001.mp4"), "utf8"), "previous-good-file");
    if (browser.gated) assert(content.assets.some(asset => asset.status === "login_required"));
  }
});

test("Douyin Edge: complete HTTP target avoids browser use, and cancellation never opens a profile", async t => {
  const current = await context(t); transport(t); let captured = 0;
  const deps: DouyinDeps = { probeMedia: probe, captureBrowser: async () => { captured++; throw new Error("browser should not be needed"); } };
  const saved = await acquireDouyin(input, current, deps); assert(saved.assets.some(asset => asset.status === "saved")); assert.equal(captured, 0);
  const controller = new AbortController(); controller.abort(); const cancelled = await acquireDouyin(input, { ...current, signal: controller.signal }, deps);
  assert(!cancelled.assets.some(asset => asset.status === "saved")); assert.equal(captured, 0);
});

test("Douyin Edge: an identity-verified target is preserved when browser gating is only a coarse signal", async t => {
  const current = await context(t); transport(t, "<html><title>抖音</title></html>");
  const content = await acquireDouyin(input, current, { probeMedia: probe, runTool: async () => ({ code: 1, stdout: "", stderr: "cookies", cancelled: false, timedOut: false, outputTruncated: false }), captureBrowser: async () => ({
    finalUrl: input.canonicalUrl, html: "<title>登录演示 - 抖音</title>", responses: [{ url: `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${id}`, data: { aweme_detail: work } }], gated: true,
  }) });
  assert(content.assets.some(asset => asset.status === "saved")); assert.equal(content.markdown, work.desc);
});

test("Douyin Edge: accessible empty data is unavailable rather than a fabricated login requirement", async t => {
  const current = await context(t); transport(t, state({ ...work, video: { duration: 19000 } }));
  const content = await acquireDouyin(input, current, { probeMedia: probe, captureBrowser: async () => ({ finalUrl: input.canonicalUrl, html: "视频数据加载中", responses: [], gated: false }), runTool: async () => ({ code: 1, stdout: "", stderr: "Fresh cookies are needed", cancelled: false, timedOut: false, outputTruncated: false }) });
  assert(content.assets.some(asset => asset.status === "unavailable")); assert(!content.assets.some(asset => asset.status === "login_required")); assert.equal(content.markdown, work.desc);
});

test("Douyin Edge: non-success official JSON cannot supply a media subject", async t => {
  const current = await context(t); const calls = transport(t);
  t.mock.method(globalThis, "fetch", async () => { calls.push({ url: input.url, headers: new Headers() }); return new Response("blocked", { status: 403 }); });
  const content = await acquireDouyin(input, current, { probeMedia: probe, captureBrowser: async () => ({ finalUrl: input.canonicalUrl, html: "", responses: [{ url: `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${id}`, data: { status_code: 8, aweme_detail: work } }], gated: false }) });
  assert(!content.assets.some(asset => asset.status === "saved")); assert.equal(calls.length, 1);
});

test("Douyin Edge: cancellation during capture keeps precise text and never starts media transfer", async t => {
  const current = await context(t); const calls = transport(t, state({ ...work, video: { duration: 19000 } })); const controller = new AbortController();
  const content = await acquireDouyin(input, { ...current, signal: controller.signal }, { probeMedia: probe, captureBrowser: async () => { controller.abort(); return { finalUrl: input.canonicalUrl, html: state(work), responses: [], gated: false }; } });
  assert(!content.assets.some(asset => asset.status === "saved")); assert.match(content.warnings.join(" "), /取消/); assert.equal(content.markdown, work.desc); assert.equal(calls.length, 1);
});

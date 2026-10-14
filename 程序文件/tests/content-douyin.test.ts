import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promises as dns } from "node:dns";
import { acquireDouyin as acquireDouyinModule, extractDouyinWork, type DouyinDeps } from "../src/content-douyin.js";
import { runContentTool } from "../src/content-tools.js";
import type { ContentInput, ContentContext } from "../src/content-types.js";
import {contentStatus} from "../src/content-library.js";

const id = "6961737553342991651";
const input = { platform: "douyin", nativeId: id, url: `https://www.douyin.com/video/${id}`, canonicalUrl: `https://www.douyin.com/video/${id}` } as ContentInput;
const mediaUrl = "https://media.example.com/clip.mp4?signature=fixture-only";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL+XQAAAABJRU5ErkJggg==", "base64");
const photoMotionBytes = Buffer.from([0, 0, 0, 16, ...Buffer.from("ftypisom"), 0, 0, 0, 0]);
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
    if (String(url).startsWith("https://www.douyin.com/")) return new Response(html, { headers: { "content-type": "text/html" } });
    if (/\.(webp|png|jpe?g)(?:\?|$)/.test(String(url))) return new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length) } });
    if (String(url).includes("photo-motion.mp4")) return new Response(photoMotionBytes, { headers: { "content-type": "video/mp4", "content-length": String(photoMotionBytes.length) } });
    return new Response("abcdefgh", { headers: { "content-type": "video/mp4", "content-length": "8" } });
  });
  return calls;
}
const probe: DouyinDeps["probeMedia"] = async () => ({ video: true, audio: true, durationSeconds: 19 });

const noteInput = { ...input, url: `https://www.douyin.com/note/${id}`, canonicalUrl: `https://www.douyin.com/note/${id}` };
const photoUrls = ["https://media.example.com/photo-one.webp", "https://media.example.com/photo-two.webp"];
const motionUrl = "https://media.example.com/photo-motion.mp4?signature=fixture-only";
const galleryWork = (images: unknown[]) => ({ ...work, aweme_type: 68, video: undefined, images });

test("Douyin photos: precise images preserve source order, original URLs and one stable ID per photo", () => {
  const snapshot = extractDouyinWork(state(galleryWork([
    { url_list: [photoUrls[0], "https://media.example.com/photo-one-backup.webp"] },
    null,
    { url_list: [photoUrls[1]], video: { duration: 2967, play_addr_h264: { url_list: [motionUrl] }, play_addr: { url_list: ["https://media.example.com/other-quality.mp4"] } } },
  ])), id);
  assert(snapshot);
  assert.equal(snapshot.images, true);
  assert.equal(snapshot.photos?.length, 3);
  assert.deepEqual(snapshot.photos?.map(photo => [photo.id, photo.index, photo.imageUrls]), [
    ["photo-001", 1, [photoUrls[0], "https://media.example.com/photo-one-backup.webp"]],
    ["photo-002", 2, []],
    ["photo-003", 3, [photoUrls[1]]],
  ]);
  assert.deepEqual(snapshot.photos?.[2].motionUrls, [motionUrl, "https://media.example.com/other-quality.mp4"]);
  assert.equal(snapshot.photos?.[2].durationSeconds, 2.967);
  assert.equal(snapshot.photos?.[0].motionExpected, false);
  assert.equal(snapshot.photos?.[2].motionExpected, true);
});

test("Douyin photos: explicit missing/protected motion stays declared and never uses unrelated nested media", () => {
  const snapshot = extractDouyinWork(state({ ...galleryWork([
    { url_list: [photoUrls[0]], live_photo_type: 1 },
    { url_list: [photoUrls[1]], video: { has_drm: true, play_addr: { url_list: [motionUrl] } } },
  ]), recommendation: { images: [{ url_list: ["https://media.example.com/unrelated.webp"], video: { play_addr: { url_list: ["https://media.example.com/unrelated.mp4"] } } }] } }), id);
  assert(snapshot);
  assert.deepEqual(snapshot.photos?.map(photo => [photo.motionExpected, photo.motionUrls]), [[true, []], [true, []]]);
  assert.match(snapshot.photos?.[1].reason ?? "", /保护|加密/);
});

test("Douyin photos: contradictory work identities and per-photo work identities are rejected before media selection", () => {
  assert.throws(() => extractDouyinWork(state({ ...galleryWork([{ url_list: [photoUrls[0]] }]), awemeId: "6982497745948921092" }), id), /身份/);
  assert.throws(() => extractDouyinWork(state(galleryWork([{ aweme_id: "6982497745948921092", url_list: [photoUrls[0]] }])), id), /身份/);
  assert.throws(() => extractDouyinWork(state(galleryWork([{ url_list: [photoUrls[0]], video: { aweme_id: "6982497745948921092", play_addr: { url_list: [motionUrl] } } }])), id), /身份/);
});

test("Douyin photos: static multi-photo originals are saved as a collection without invoking yt-dlp", async t => {
  const current = await context(t); const calls = transport(t, state(galleryWork(photoUrls.map(url => ({ url_list: [url] })))));
  let tools = 0;
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    calls.push({ url: String(url), headers: new Headers() });
    return String(url).startsWith("https://www.douyin.com/") ? new Response(state(galleryWork(photoUrls.map(url => ({ url_list: [url] }))))) : new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length) } });
  });
  const record = await acquireDouyin(noteInput, current, { runTool: async () => { tools++; throw new Error("gallery must not use yt-dlp"); } });
  assert.equal(record.kind, "gallery"); assert.equal(record.markdown, work.desc);
  assert.equal(record.assets.filter(asset => asset.role === "image" && asset.status === "saved").length, 2, JSON.stringify(record));
  assert.equal(record.assets.filter(asset => asset.role === "video").length, 0);
  assert.equal(contentStatus({ ...record, processingMode: "original" }), "completed");
  assert.equal(tools, 0);
});

test("Douyin photos: incomplete HTTP photo data is enriched from the exact browser detail and preserves the original description", async t => {
  const current = await context(t); const calls = transport(t, state(galleryWork([{ url_list: [photoUrls[0]], live_photo_type: 1 }])));
  let tools = 0, captures = 0;
  const record = await acquireDouyin(noteInput, current, {
    captureBrowser: async (_input, _context, requests) => {
      captures++; assert.equal(new URL(requests[0].url).searchParams.get("aweme_id"), id);
      return { finalUrl: noteInput.url, html: "", gated: false, responses: [{ url: requests[0].url, data: { status_code: 0, aweme_detail: { ...galleryWork([{ url_list: [photoUrls[0]], video: { duration: 2967, play_addr: { url_list: [motionUrl] } } }]), desc: "" } } }] };
    },
    probeMedia: async () => ({ video: true, audio: true, durationSeconds: 2.967 }),
    runTool: async () => { tools++; throw new Error("gallery must not use yt-dlp"); },
  });
  assert.equal(captures, 1); assert.equal(tools, 0); assert.equal(record.markdown, work.desc);
  assert.equal(record.assets.filter(asset => asset.role === "image" && asset.status === "saved").length, 1, JSON.stringify(record));
  assert.equal(record.assets.filter(asset => asset.role === "video" && asset.status === "saved").length, 1, JSON.stringify(record));
  assert(calls.some(call => call.url === motionUrl));
});

test("Douyin photos: missing original image or a declared motion stream makes original-mode result partial", async t => {
  const current = await context(t); transport(t, state(galleryWork([
    { url_list: [photoUrls[0]], live_photo_type: 1 },
    { video: { play_addr: { url_list: [motionUrl] }, duration: 2967 } },
  ])));
  const record = await acquireDouyin(noteInput, current, { probeMedia: async () => ({ video: true, audio: true, durationSeconds: 2.967 }) });
  assert.equal(contentStatus({ ...record, processingMode: "original" }), "partial");
  assert(record.assets.some(asset => asset.role === "video" && asset.status === "unavailable"));
  assert(record.assets.some(asset => asset.role === "image" && asset.status === "unavailable"));
  assert.equal(record.assets.filter(asset => asset.status === "saved").length, 2, JSON.stringify(record));
});

test("Douyin photos: cancellation after first original preserves its checkpoint and skips later photo requests", async t => {
  const current = await context(t); const controller = new AbortController(); const calls = transport(t, state(galleryWork(photoUrls.map(url => ({ url_list: [url] })))));
  const record = await acquireDouyin(noteInput, { ...current, signal: controller.signal, onCheckpoint: async record => {
    if (record.assets.some(asset => asset.role === "image" && asset.status === "saved")) controller.abort();
  } });
  assert.equal(record.assets.filter(asset => asset.role === "image" && asset.status === "saved").length, 1, JSON.stringify(record));
  assert.equal(new Set(record.assets.map(asset => asset.id)).size, record.assets.length, "cancellation must not add a duplicate failure for the saved first image");
  assert(calls.some(call => call.url === photoUrls[0])); assert(!calls.some(call => call.url === photoUrls[1]));
  const saved = record.assets.find(asset => asset.role === "image" && asset.status === "saved"); assert(saved?.path);
  assert.deepEqual(await fs.readFile(path.join(current.directory, saved.path)), png);
});

test("Douyin photos: mixed static and motion originals retain independent ordered assets and movie part IDs", async t => {
  const current = await context(t); const calls = transport(t, state(galleryWork([
    { url_list: [photoUrls[0]] },
    { url_list: [photoUrls[1]], video: { duration: 2967, play_addr: { url_list: [motionUrl] } } },
  ])));
  const record = await acquireDouyin(noteInput, current, { probeMedia: async () => ({ video: true, audio: false, durationSeconds: 2.967 }) });
  assert.equal(contentStatus({ ...record, processingMode: "original" }), "completed", JSON.stringify(record));
  assert.deepEqual(record.assets.map(asset => [asset.role, asset.status]), [["image", "saved"], ["image", "saved"], ["video", "saved"]]);
  assert.deepEqual(record.assets.filter(asset => asset.role === "image").map(asset => asset.id), ["images/001", "images/002"]);
  assert.equal(record.parts?.length, 1); assert.equal(record.parts?.[0].status, "saved");
  assert.equal(record.assets[2].partId, record.parts?.[0].id);
  assert.deepEqual(calls.map(call => call.url), [noteInput.url, ...photoUrls, motionUrl]);
});

test("Douyin photos: a known gallery with an unknown empty image list stays explicitly partial", async t => {
  const current = await context(t); transport(t, state(galleryWork([])));
  let tools = 0, captures = 0;
  const record = await acquireDouyin(noteInput, current, {
    captureBrowser: async () => { captures++; return { finalUrl: noteInput.url, html: "", responses: [], gated: false }; },
    runTool: async () => { tools++; throw new Error("no yt-dlp gallery inference"); },
  });
  assert.equal(captures, 1); assert.equal(tools, 0);
  assert.equal(record.kind, "gallery"); assert.equal(contentStatus({ ...record, processingMode: "original" }), "partial");
  assert(record.assets.some(asset => asset.role === "image" && asset.status === "unavailable"));
  assert.match(record.assets.find(asset => asset.role === "image" && asset.status === "unavailable")?.reason ?? "", /数量|照片|未知/);
});

test("Douyin photos: a corrupt retry cannot overwrite previously saved original image bytes", async t => {
  const current = await context(t); transport(t, state(galleryWork([{ url_list: [photoUrls[0]] }])));
  const previous = await acquireDouyin(noteInput, current);
  const original = previous.assets.find(asset => asset.role === "image" && asset.status === "saved"); assert(original?.path);
  const newSource = "https://media.example.com/new-version.webp";
  t.mock.method(globalThis, "fetch", async (url: URL) => String(url).startsWith("https://www.douyin.com/") ? new Response(state(galleryWork([{ url_list: [newSource] }]))) : new Response("invalid image payload", { headers: { "content-type": "image/png" } }));
  const retry = await acquireDouyin(noteInput, { ...current, existing: previous });
  assert.equal(contentStatus({ ...retry, processingMode: "original" }), "partial");
  assert(!retry.assets.some(asset => asset.status === "saved"));
  assert.deepEqual(await fs.readFile(path.join(current.directory, original.path)), png);
  assert.equal(previous.assets[0].status, "saved");
});

const slidesPath = "/web/api/v2/aweme/slidesinfo/";
function slidesTransport(t: TestContext, payload: unknown, html = "<html><title>抖音</title></html>") {
  const calls = transport(t, html);
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(options.headers) });
    if (new URL(String(url)).pathname === slidesPath) {
      const rawIds = new URL(String(url)).searchParams.get("aweme_ids") ?? "";
      const response = /^\[[1-9]\d{14,21}\]$/.test(rawIds) ? payload : { status_code: 0, aweme_details: null };
      return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
    }
    if (String(url).startsWith("https://www.douyin.com/")) return new Response(html, { headers: { "content-type": "text/html" } });
    return /\.mp4(?:\?|$)/.test(String(url)) ? new Response(photoMotionBytes, { headers: { "content-type": "video/mp4" } }) : new Response(png, { headers: { "content-type": "image/png" } });
  });
  return calls;
}

test("Douyin slides: official photo metadata succeeds when the v1 detail has no target and does not use gallery BGM as motion", async t => {
  const current = await context(t); const publicId = "7635876375336879226";
  const submitted = { ...noteInput, nativeId: publicId, url: `https://www.douyin.com/note/${publicId}`, canonicalUrl: `https://www.douyin.com/note/${publicId}` };
  const details = { ...galleryWork(photoUrls.map(url => ({ url_list: [url], download_url_list: ["https://media.example.com/download-image.webp"], uri: "image-resource", width: 1, height: 1 }))), aweme_id: publicId, video: { has_drm: true, duration: 19000, play_addr: { url_list: ["https://media.example.com/bgm.mp4"] } } };
  const calls = slidesTransport(t, { status_code: 0, aweme_details: [details] });
  let captures = 0, tools = 0;
  const record = await acquireDouyin(submitted, current, {
    captureBrowser: async () => { captures++; return { finalUrl: submitted.url, html: "", gated: false, responses: [{ url: `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${publicId}`, data: { status_code: 0, aweme_detail: null } }] }; },
    runTool: async () => { tools++; throw new Error("gallery must not invoke yt-dlp"); },
  });
  assert.equal(record.assets.filter(asset => asset.role === "image" && asset.status === "saved").length, 2, JSON.stringify(record));
  assert.equal(contentStatus({ ...record, processingMode: "original" }), "completed");
  assert.equal(record.assets.filter(asset => asset.role === "video").length, 0); assert.equal(tools, 0); assert.equal(captures, 0);
  const api = calls.find(call => new URL(call.url).pathname === slidesPath); assert(api);
  const endpoint = new URL(api.url); assert.equal(endpoint.origin, "https://www.iesdouyin.com");
  assert.equal(endpoint.searchParams.get("aweme_ids"), `[${publicId}]`, "official API requires a decimal numeric array, preserving all 19 ID digits without Number conversion"); assert.equal(endpoint.searchParams.get("request_source"), "200");
  assert.equal(api.headers.has("cookie"), false); assert.equal(api.headers.has("authorization"), false);
  assert(!calls.some(call => call.url.includes("bgm.mp4") || call.url.includes("download-image.webp")));
});

test("Douyin slides: wrong or contradictory response identities stop before browser or photo requests", async t => {
  const current = await context(t);
  for (const details of [
    [{ ...galleryWork([{ url_list: [photoUrls[0]] }]), aweme_id: "6982497745948921092" }],
    [galleryWork([{ url_list: [photoUrls[0]] }]), galleryWork([{ url_list: [photoUrls[1]] }])],
    [{ ...galleryWork([{ url_list: [photoUrls[0]] }]), awemeId: "6982497745948921092" }],
  ]) {
    const calls = slidesTransport(t, { status_code: 0, aweme_details: details }); let captures = 0;
    const record = await acquireDouyin(noteInput, current, { captureBrowser: async () => { captures++; throw new Error("mismatched response must stop"); } });
    assert(calls.some(call => new URL(call.url).pathname === slidesPath));
    assert(!record.assets.some(asset => asset.status === "saved")); assert.match(record.warnings.join(" "), /身份|不一致/);
    assert.equal(captures, 0); assert(!calls.some(call => photoUrls.includes(call.url)));
  }
});

test("Douyin slides: incomplete motion metadata falls back to exact Edge detail and keeps known static description", async t => {
  const current = await context(t); const declared = galleryWork([{ url_list: [photoUrls[0]], live_photo_type: 1 }]);
  const calls = slidesTransport(t, { status_code: 0, aweme_details: [declared] }); let captures = 0;
  const record = await acquireDouyin(noteInput, current, {
    captureBrowser: async (_input, _context, requests) => {
      captures++; return { finalUrl: noteInput.url, html: "", gated: false, responses: [{ url: requests[0].url, data: { status_code: 0, aweme_detail: { ...galleryWork([{ url_list: [photoUrls[0]], video: { duration: 2967, play_addr: { url_list: [motionUrl] } } }]), desc: "" } } }] };
    }, probeMedia: async () => ({ video: true, audio: true, durationSeconds: 2.967 }),
  });
  assert.equal(captures, 1); assert.equal(record.markdown, work.desc);
  assert.equal(record.assets.filter(asset => asset.role === "image" && asset.status === "saved").length, 1);
  assert.equal(record.assets.filter(asset => asset.role === "video" && asset.status === "saved").length, 1);
  assert(calls.some(call => new URL(call.url).pathname === slidesPath));
});

test("Douyin slides: a declared missing motion stays partial when the v1 detail is empty", async t => {
  const current = await context(t); const calls = slidesTransport(t, { status_code: 0, aweme_details: [galleryWork([{ url_list: [photoUrls[0]], live_photo_type: 1 }])] });
  const record = await acquireDouyin(noteInput, current, { captureBrowser: async (_input, _context, requests) => ({ finalUrl: noteInput.url, html: "", gated: false, responses: [{ url: requests[0].url, data: { status_code: 0, aweme_detail: null } }] }) });
  assert.equal(record.assets.filter(asset => asset.role === "image" && asset.status === "saved").length, 1);
  assert(record.assets.some(asset => asset.role === "video" && asset.status === "unavailable"));
  assert.equal(contentStatus({ ...record, processingMode: "original" }), "partial");
  assert(calls.some(call => new URL(call.url).pathname === slidesPath));
});

test("Douyin slides: nonzero status and nested recommendation images cannot supply a photo collection", async t => {
  const current = await context(t); const calls = slidesTransport(t, { status_code: 1, aweme_details: [galleryWork([{ url_list: [photoUrls[0]] }])], recommendations: { aweme_details: [galleryWork([{ url_list: [photoUrls[1]] }])] } });
  const record = await acquireDouyin(noteInput, current);
  assert(calls.some(call => new URL(call.url).pathname === slidesPath)); assert(!record.assets.some(asset => asset.status === "saved"));
  assert(!calls.some(call => photoUrls.includes(call.url)));
});

test("Douyin photo URI: declared resource identity is stable and keeps unrelated image_id namespaces separate", () => {
  const snapshot = extractDouyinWork(state(galleryWork([
    { uri: "original-resource", image_id: "display-id-one", url_list: [photoUrls[0]] },
    { uri: "original-resource", image_id: "display-id-two", url_list: [photoUrls[1]] },
    { image_id: "original-resource", url_list: [photoUrls[0]] },
  ])), id);
  assert.deepEqual(snapshot?.photos?.map(photo => [photo.id, photo.index]), [["uri:original-resource", 1], ["uri:original-resource", 2], ["photo-003", 3]]);
});

test("Douyin photo URI: a conflicting resource cannot pair old static A with motion B or shorten the original denominator", async t => {
  const current = await context(t); const newB = "https://media.example.com/new-resource-b.webp";
  const prior = galleryWork([
    { uri: "resource-A", url_list: [photoUrls[0]], live_photo_type: 1 },
    { uri: "resource-C", url_list: [photoUrls[1]] },
  ]);
  const replacement = galleryWork([{ uri: "resource-B", url_list: [newB], video: { duration: 2967, play_addr: { url_list: [motionUrl] } } }]);
  const calls = slidesTransport(t, { status_code: 0, aweme_details: [replacement] }, state(prior));
  const originalTransport = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    if (String(url) === newB) { calls.push({ url: String(url), headers: new Headers(options.headers) }); return new Response("unavailable B", { status: 502 }); }
    return originalTransport(url, options);
  });
  const record = await acquireDouyin(noteInput, current, { probeMedia: async () => ({ video: true, audio: true, durationSeconds: 2.967 }) });
  assert.equal(contentStatus({ ...record, processingMode: "original" }), "partial", JSON.stringify(record));
  assert.equal(record.assets.filter(asset => asset.role === "image" && asset.status === "saved").length, 2);
  assert.equal(record.assets.filter(asset => asset.role === "video" && asset.status === "saved").length, 0);
  assert(record.assets.some(asset => asset.role === "video" && asset.status === "unavailable"));
  assert.match(record.coverage?.photos ?? "", /2\/2 original photos/);
  assert(!calls.some(call => call.url === newB || call.url === motionUrl));
  assert.match(record.warnings.join(" "), /身份|资源|不一致/);
});

test("Douyin photo URI: the same resource with renewed signed URLs safely enriches its missing motion", async t => {
  const current = await context(t); const oldSigned = `${photoUrls[0]}?signature=OLD_FIXTURE`, newSigned = `${photoUrls[0]}?signature=NEW_FIXTURE`;
  const prior = galleryWork([{ uri: "resource-A", image_id: "renderer-A", url_list: [oldSigned], live_photo_type: 1 }]);
  const enriched = galleryWork([{ uri: "resource-A", image_id: "detail-A", url_list: [newSigned], video: { duration: 2967, play_addr: { url_list: [motionUrl] } } }]);
  const calls = slidesTransport(t, { status_code: 0, aweme_details: [enriched] }, state(prior));
  const record = await acquireDouyin(noteInput, current, { probeMedia: async () => ({ video: true, audio: true, durationSeconds: 2.967 }) });
  assert.equal(contentStatus({ ...record, processingMode: "original" }), "completed", JSON.stringify(record));
  assert.equal(record.assets.filter(asset => asset.role === "image" && asset.status === "saved").length, 1);
  assert.equal(record.assets.filter(asset => asset.role === "video" && asset.status === "saved").length, 1);
  assert(calls.some(call => call.url === newSigned)); assert(calls.some(call => call.url === motionUrl));
});

test("Douyin photo URI: the same declared resource at different positions preserves two independent motion members", async t => {
  const current = await context(t); const secondMotion = `${motionUrl}&position=second`;
  const duplicate = galleryWork([
    { uri: "shared-resource", url_list: [photoUrls[0]], video: { duration: 2967, play_addr: { url_list: [motionUrl] } } },
    { uri: "shared-resource", url_list: [photoUrls[1]], video: { duration: 2967, play_addr: { url_list: [secondMotion] } } },
  ]);
  const snapshot = extractDouyinWork(state(duplicate), id);
  assert.equal(snapshot?.photos?.[0].id, snapshot?.photos?.[1].id);
  slidesTransport(t, { status_code: 0, aweme_details: [duplicate] }, state(duplicate));
  const record = await acquireDouyin(noteInput, current, { probeMedia: async () => ({ video: true, audio: true, durationSeconds: 2.967 }) });
  const movies = record.assets.filter(asset => asset.role === "video" && asset.status === "saved");
  assert.equal(movies.length, 2); assert.equal(new Set(movies.map(asset => asset.id)).size, 2);
  assert.equal(new Set(record.parts?.map(part => part.id)).size, 2);
  assert.equal(contentStatus({ ...record, processingMode: "original" }), "completed");
});

test("Douyin quality: image candidates retain signed URLs, declared pixels and watermarked download fallback", () => {
  const webp = "https://p26-sign.douyinpic.com/tos-cn-i-0813/photo-A~tplv-dy-aweme-images:q75.webp?x-signature=Fixture%2B%2F%3D&x-expires=123";
  const jpeg = webp.replace(".webp?", ".jpeg?");
  const download = "https://p11-sign.douyinpic.com/tos-cn-i-0813/photo-A~tplv-dy-water-v2:user:2160:3840.webp?sig=Fixture%2F%3D";
  const snapshot = extractDouyinWork(state(galleryWork([{ uri: "tos-cn-i-0813/photo-A", width: 2160, height: 3840, url_list: [webp, jpeg], download_url_list: [download] }])), id);
  const photo = snapshot?.photos?.[0]; assert(photo);
  assert.equal(photo.width, 2160); assert.equal(photo.height, 3840);
  assert.deepEqual(photo.imageUrls, [webp, jpeg, download]);
  assert.deepEqual(photo.imageCandidates?.map(candidate => [candidate.url, candidate.source, candidate.rendition, candidate.watermark, candidate.evidence, candidate.width, candidate.height]), [
    [webp, "provided", "playback", "unknown", undefined, 2160, 3840],
    [jpeg, "provided", "playback", "unknown", undefined, 2160, 3840],
    [download, "provided", "download", "present", "known_template", 2160, 3840],
  ]);
});

test("Douyin quality: a known watermark download cannot outrank an unmarked provided image", () => {
  const clean = photoUrls[0], marked = "https://p11-sign.douyinpic.com/photo~tplv-dy-water-v2:user:2160:3840.jpeg?watermark=1";
  const snapshot = extractDouyinWork(state(galleryWork([{ url_list: [marked, clean], download_url_list: [marked], width: 2160, height: 3840 }])), id);
  assert.deepEqual(snapshot?.photos?.[0].imageUrls, [clean, marked]);
  assert.deepEqual(snapshot?.photos?.[0].imageCandidates?.map(candidate => [candidate.url, candidate.watermark]), [[clean, "unknown"], [marked, "present"]]);
});

test("Douyin quality: the highest motion pixels win across codecs and equal pixels use bitrate", () => {
  const high = "https://media.example.com/high-hevc.mp4", highestRate = "https://media.example.com/high-hevc-bitrate.mp4", low = "https://media.example.com/low-h264.mp4";
  const snapshot = extractDouyinWork(state(galleryWork([{ uri: "image-resource", url_list: [photoUrls[0]], video: {
    duration: 2967, has_watermark: false,
    play_addr_h264: { uri: "motion-resource", width: 720, height: 960, url_list: [low] },
    bit_rate: [
      { bit_rate: 2000000, is_h265: 1, play_addr: { uri: "motion-resource", width: 1440, height: 1920, url_list: [high] } },
      { bit_rate: 3000000, is_h265: 1, play_addr: { uri: "motion-resource", width: 1440, height: 1920, url_list: [highestRate] } },
    ],
  } }])), id);
  assert.deepEqual(snapshot?.photos?.[0].motionUrls, [highestRate, high, low]);
  assert.deepEqual(snapshot?.photos?.[0].motionCandidates?.map(candidate => [candidate.url, candidate.width, candidate.height, candidate.bitrate, candidate.watermark, candidate.evidence, candidate.durationSeconds]), [
    [highestRate, 1440, 1920, 3000000, "none", "platform_flag", 2.967],
    [high, 1440, 1920, 2000000, "none", "platform_flag", 2.967],
    [low, 720, 960, undefined, "none", "platform_flag", 2.967],
  ]);
});

test("Douyin quality: a shared address keeps its higher bitrate metadata when a default stream aliases it", () => {
  const shared = "https://media.example.com/shared-motion.mp4", alternate = "https://media.example.com/alternate-motion.mp4";
  const snapshot = extractDouyinWork(state(galleryWork([{ url_list: [photoUrls[0]], video: {
    has_watermark: false,
    play_addr_h264: { uri: "motion-resource", width: 720, height: 960, url_list: [shared] },
    bit_rate: [
      { bit_rate: 3000000, play_addr: { uri: "motion-resource", width: 720, height: 960, url_list: [shared] } },
      { bit_rate: 2500000, play_addr: { uri: "motion-resource", width: 720, height: 960, url_list: [alternate] } },
    ],
  } }])), id);
  assert.deepEqual(snapshot?.photos?.[0].motionUrls, [shared, alternate]);
  assert.equal(snapshot?.photos?.[0].motionCandidates?.[0].bitrate, 3000000);
});

test("Douyin quality: explicit video identities stay opaque and stable across signed URLs without inventing missing IDs", () => {
  const photo = (uri: string | undefined, url: string, imageUri = "image-resource") => extractDouyinWork(state(galleryWork([{ uri: imageUri, url_list: [photoUrls[0]], video: { play_addr: { ...(uri ? { uri } : {}), url_list: [url] } } }])), id)?.photos?.[0];
  const first = photo("video-resource-A", `${motionUrl}&refresh=old`), renewed = photo("video-resource-A", `${motionUrl}&refresh=new`);
  const changed = photo("video-resource-B", motionUrl), absent = photo(undefined, motionUrl);
  const originalId = first?.motionCandidates?.[0].resourceId; assert.match(originalId ?? "", /^[a-f0-9]{64}$/);
  assert.equal(renewed?.motionCandidates?.[0].resourceId, originalId);
  assert.notEqual(changed?.motionCandidates?.[0].resourceId, originalId);
  assert.equal(absent?.motionCandidates?.[0].resourceId, undefined);
  assert.equal(photo("video-resource-A", motionUrl, "another-image-resource")?.motionCandidates?.[0].resourceId, originalId, "image and video URI namespaces remain independent");
});

test("Douyin quality: video watermark flags keep false, true-download-only and unknown scopes distinct", () => {
  const download = "https://media.example.com/download-motion.mp4";
  for (const [flag, playbackMark, downloadMark] of [[false, "none", "none"], [true, "unknown", "present"], [undefined, "unknown", "unknown"]] as const) {
    const snapshot = extractDouyinWork(state(galleryWork([{ url_list: [photoUrls[0]], video: {
      ...(flag !== undefined ? { has_watermark: flag } : {}), duration: 2967,
      play_addr: { uri: "motion-resource", width: 720, height: 960, url_list: [motionUrl] },
      download_addr: { uri: "motion-resource", width: 720, height: 960, url_list: [download] },
    } }])), id);
    const candidates = snapshot?.photos?.[0].motionCandidates; assert(candidates);
    assert.equal(candidates.find(candidate => candidate.url === motionUrl)?.watermark, playbackMark);
    assert.equal(candidates.find(candidate => candidate.url === download)?.watermark, downloadMark);
    assert.equal(candidates.find(candidate => candidate.url === download)?.rendition, "download");
    assert.equal(candidates.find(candidate => candidate.url === download)?.evidence, flag === undefined ? undefined : "platform_flag");
  }
});

test("Douyin quality: address flags and literal watermarked paths win without rewriting source URLs", () => {
  const markedPath = "https://www.iesdouyin.com/aweme/v1/playwm/?video_id=motion-resource&ratio=720p&signature=Fixture%2B%3D";
  const markedQuery = "https://media.example.com/query-motion.mp4?watermark=1&signature=Fixture%2F%3D";
  const clean = "https://media.example.com/clean-motion.mp4?signature=Fixture%2B%3D";
  const snapshot = extractDouyinWork(state(galleryWork([{ url_list: [photoUrls[0]], video: {
    has_watermark: true, duration: 2967,
    play_addr_h264: { uri: "motion-resource", width: 2160, height: 2880, is_watermark: false, url_list: [markedPath, markedQuery] },
    play_addr: { uri: "motion-resource", width: 720, height: 960, has_watermark: false, url_list: [clean] },
  } }])), id);
  assert.deepEqual(snapshot?.photos?.[0].motionUrls, [clean, markedPath, markedQuery]);
  assert.deepEqual(snapshot?.photos?.[0].motionCandidates?.map(candidate => [candidate.url, candidate.watermark, candidate.evidence]), [
    [clean, "none", "platform_flag"], [markedPath, "present", "known_template"], [markedQuery, "present", "known_template"],
  ]);
  assert(!snapshot?.photos?.[0].motionUrls.some(url => url.includes("/play/?") || url.includes("ratio=1080p")));
});

test("Douyin quality: conflicting motion URIs keep the original image and decline mixed video candidates", () => {
  const snapshot = extractDouyinWork(state(galleryWork([{ uri: "image-resource", url_list: [photoUrls[0]], video: {
    duration: 2967, has_watermark: false,
    play_addr_h264: { uri: "motion-A", width: 720, height: 960, url_list: [motionUrl] },
    bit_rate: [{ bit_rate: 3000000, play_addr: { uri: "motion-B", width: 1440, height: 1920, url_list: ["https://media.example.com/motion-B.mp4"] } }],
  } }])), id);
  const photo = snapshot?.photos?.[0]; assert(photo);
  assert.equal(photo.id, "uri:image-resource"); assert.deepEqual(photo.imageUrls, [photoUrls[0]]);
  assert.equal(photo.motionExpected, true); assert.deepEqual(photo.motionUrls, []); assert.deepEqual(photo.motionCandidates, []);
  assert.match(photo.reason ?? "", /动态视频资源身份.*不一致/);
});

test("Douyin protection: bitrate owner and address declarations both gate motion while preserving the static photo", () => {
  for (const bitrate of [
    { has_drm: true, play_addr: { uri: "motion-resource", url_list: [motionUrl], width: 1080, height: 1920 } },
    { play_addr: { uri: "motion-resource", is_drm: true, url_list: [motionUrl], width: 1080, height: 1920 } },
    { download_addr: { uri: "motion-resource", drm: { protected: true }, url_list: [motionUrl], width: 1080, height: 1920 } },
  ]) {
    const snapshot = extractDouyinWork(state(galleryWork([{ uri: "image-resource", url_list: [photoUrls[0]], video: { duration: 2967, bit_rate: [bitrate] } }])), id);
    const photo = snapshot?.photos?.[0]; assert(photo);
    assert.equal(photo.motionProtected, true); assert.equal(photo.motionExpected, true);
    assert.deepEqual(photo.motionUrls, []); assert.deepEqual(photo.motionCandidates, []);
    assert.deepEqual(photo.imageUrls, [photoUrls[0]]); assert.match(photo.reason ?? "", /保护|加密/);
  }
});

test("Douyin protection: a clear alias cannot reintroduce the same protected URI or URL at another quality", () => {
  const snapshot = extractDouyinWork(state(galleryWork([{ uri: "image-resource", url_list: [photoUrls[0]], video: {
    has_watermark: false,
    play_addr_h264: { uri: "motion-resource", url_list: [motionUrl], width: 720, height: 960 },
    bit_rate: [{ has_drm: true, play_addr: { uri: "motion-resource", url_list: [motionUrl], width: 1440, height: 1920 } }],
  } }])), id);
  assert.equal(snapshot?.photos?.[0].motionProtected, true);
  assert.deepEqual(snapshot?.photos?.[0].motionCandidates, []); assert.deepEqual(snapshot?.photos?.[0].motionUrls, []);
});

test("Douyin protection: known protected aliases propagate across photo positions while an independent URI stays usable", () => {
  const alias = "https://media.example.com/protected-alias.mp4", independent = "https://media.example.com/independent-motion.mp4";
  const snapshot = extractDouyinWork(state(galleryWork([
    { uri: "image-one", url_list: [photoUrls[0]], video: { bit_rate: [{ has_drm: true, play_addr: { uri: "motion-protected", url_list: [motionUrl] } }] } },
    { uri: "image-two", url_list: [photoUrls[1]], video: { play_addr: { uri: "motion-protected", url_list: [alias] } } },
    { uri: "image-three", url_list: [photoUrls[0]], video: { play_addr: { url_list: [alias] } } },
    { uri: "image-four", url_list: [photoUrls[1]], video: { play_addr: { uri: "motion-independent", url_list: [independent] } } },
  ])), id);
  assert.equal(snapshot?.photos?.length, 4);
  assert.deepEqual(snapshot?.photos?.map(photo => photo.imageUrls), [[photoUrls[0]], [photoUrls[1]], [photoUrls[0]], [photoUrls[1]]]);
  assert.deepEqual(snapshot?.photos?.map(photo => [!!photo.motionProtected, photo.motionUrls]), [[true, []], [true, []], [true, []], [false, [independent]]]);
});

test("Douyin protection: supplemental sources cannot clear a prior protected alias or reintroduce a newly protected one", async t => {
  const current = await context(t), alias = `${motionUrl}&refresh=clear-alias`;
  const protectedPhoto = { uri: "image-A", url_list: [photoUrls[0]], video: { duration: 2967, bit_rate: [{ has_drm: true, play_addr: { uri: "motion-protected", url_list: [motionUrl], width: 720, height: 960 } }] } };
  const clearPhoto = { uri: "image-A", url_list: [photoUrls[0]], video: { duration: 2967, has_watermark: false, play_addr: { uri: "motion-protected", url_list: [alias], width: 720, height: 960 } } };
  for (const [prior, supplemental] of [[protectedPhoto, clearPhoto], [{ ...clearPhoto, url_list: [] }, protectedPhoto]]) {
    const first = galleryWork([prior, { uri: "image-B", url_list: [photoUrls[1]] }]), next = galleryWork([supplemental]);
    const calls = slidesTransport(t, { status_code: 0, aweme_details: [next] }, state(first));
    const record = await acquireDouyin(noteInput, current, {
      captureBrowser: async (_input, _context, requests) => ({ finalUrl: noteInput.url, html: "", gated: false, responses: [{ url: requests[0].url, data: { status_code: 0, aweme_detail: galleryWork([clearPhoto]) } }] }),
      probeMedia: async () => ({ video: true, audio: true, durationSeconds: 2.967 }),
    });
    assert.equal(contentStatus({ ...record, processingMode: "original" }), "partial", JSON.stringify(record));
    assert.equal(record.assets.filter(asset => asset.role === "image" && asset.status === "saved").length, 2);
    assert(record.assets.some(asset => asset.role === "video" && asset.status === "unavailable" && /保护|加密/.test(asset.reason ?? "")));
    assert(!record.assets.some(asset => asset.role === "video" && asset.status === "saved"));
    assert(!calls.some(call => call.url === motionUrl || call.url === alias));
    assert.match(record.coverage?.photos ?? "", /2\/2 original photos/);
  }
});

test("Douyin quality merge: conflicting video URIs cannot attach new motion or shrink the original image denominator", async t => {
  const current = await context(t);
  const prior = galleryWork([
    { uri: "image-A", url_list: [photoUrls[0]], video: { duration: 2967, play_addr: { uri: "motion-A", url_list: [] } } },
    { uri: "image-C", url_list: [photoUrls[1]] },
  ]);
  const replacement = galleryWork([{ uri: "image-A", url_list: [photoUrls[0]], video: { duration: 2967, has_watermark: false, play_addr: { uri: "motion-B", url_list: [motionUrl], width: 720, height: 960 } } }]);
  const calls = slidesTransport(t, { status_code: 0, aweme_details: [replacement] }, state(prior));
  const record = await acquireDouyin(noteInput, current, { probeMedia: async () => ({ video: true, audio: true, durationSeconds: 2.967 }) });
  assert.equal(contentStatus({ ...record, processingMode: "original" }), "partial", JSON.stringify(record));
  assert.equal(record.assets.filter(asset => asset.role === "image" && asset.status === "saved").length, 2);
  assert(!record.assets.some(asset => asset.role === "video" && asset.status === "saved"));
  assert.match(record.coverage?.photos ?? "", /2\/2 original photos/); assert.match(record.warnings.join(" "), /动态视频资源身份.*不一致/);
  assert(!calls.some(call => call.url === motionUrl));
});

test("Douyin quality merge: signed URL refresh preserves earlier known quality metadata and photo positions", async t => {
  const current = await context(t), oldSigned = `${photoUrls[0]}?signature=OLD_FIXTURE`, newSigned = `${photoUrls[0]}?signature=NEW_FIXTURE`;
  const prior = galleryWork([
    { uri: "image-A", url_list: [oldSigned], width: 1, height: 1, has_watermark: false, live_photo_type: 1 },
    { uri: "image-C", url_list: [photoUrls[1]] },
  ]);
  const replacement = galleryWork([{ uri: "image-A", url_list: [newSigned], video: { duration: 2967, has_watermark: false, play_addr: { uri: "motion-A", url_list: [motionUrl], width: 720, height: 960 } } }]);
  slidesTransport(t, { status_code: 0, aweme_details: [replacement] }, state(prior));
  const record = await acquireDouyin(noteInput, current, { probeMedia: async () => ({ video: true, audio: true, durationSeconds: 2.967 }) });
  assert.equal(contentStatus({ ...record, processingMode: "original" }), "completed", JSON.stringify(record));
  const first = record.assets.find(asset => asset.id === "images/001" && asset.status === "saved"); assert(first);
  assert.equal(first.sourceUrl, oldSigned); assert.equal(first.quality?.watermark, "none");
  assert.equal(first.quality?.expectedWidth, 1); assert.equal(first.quality?.expectedHeight, 1);
  assert.match(record.coverage?.photos ?? "", /2\/2 original photos/);
});

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

test("Douyin: unknown image fields retain original text without inventing an original image", async t => {
  const current = await context(t); const calls = transport(t, state({ ...work, video: undefined, images: [{ display_image: { url_list: ["https://media.example.com/photo.jpg"] } }] }));
  const content = await acquireDouyin(input, current, { probeMedia: probe }); assert.equal(content.kind, "gallery"); assert.equal(content.markdown, work.desc);
  assert(!content.assets.some(asset => asset.status === "saved")); assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).pathname, slidesPath);
  assert(content.assets.some(asset => asset.role === "image" && asset.status === "unavailable"));
  assert.equal(contentStatus({ ...content, processingMode: "original" }), "partial");
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

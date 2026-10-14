import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promises as dns } from "node:dns";
import { acquireWechatChannels, extractWechatChannelsHtml, extractWechatChannelsProfile } from "../src/content-wechat-channels.js";
import { contentStatus } from "../src/content-library.js";
import type { ContentInput } from "../src/content-types.js";

const share = "https://weixin.qq.com/sph/AiFpm2ZuMh";
const input: ContentInput = { url: share, canonicalUrl: share, platform: "wechat" };
const video = "https://example.com/original.mp4";

async function setup(t: any) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "content-channels-"));
  t.after(async () => {
    if (path.dirname(path.resolve(directory)) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith("content-channels-")) await fs.rm(directory, { recursive: true, force: true });
  });
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  return { runtimeRoot: directory, directory };
}

test("Channels: extracts the single foreground video/source and excludes related media and text", () => {
  const snapshot = extractWechatChannelsHtml(`<main><h1>分享视频</h1><span class="author">作者</span><p class="description">视频正文</p><video><source src="${video}" type="video/mp4"></video><aside class="recommend"><p class="description">推荐文案</p><video src="https://example.com/other.mp4"></video></aside><div class="comments"><video src="https://example.com/comment.mp4"></video></div></main>`, share);
  assert.equal(snapshot.title, "分享视频");
  assert.equal(snapshot.author, "作者");
  assert.equal(snapshot.body, "视频正文");
  assert.deepEqual(snapshot.videos, [video]);
});

test("Channels: accepts a page-scoped Open Graph MP4 without executing scripts", () => {
  const snapshot = extractWechatChannelsHtml(`<head><meta property="og:url" content="${share}"><meta property="og:title" content="原始标题"><meta property="og:description" content="原始描述"><meta property="og:video" content="${video}?a=1&amp;b=2"><meta property="og:video:type" content="video/mp4"></head><script>throw new Error('must not execute')</script>`, share);
  assert.equal(snapshot.title, "原始标题");
  assert.equal(snapshot.body, "原始描述");
  assert.deepEqual(snapshot.videos, [`${video}?a=1&b=2`]);
});

test("Channels: refuses metadata belonging to a different share page and ambiguous foreground videos", () => {
  const wrong = extractWechatChannelsHtml(`<meta property="og:url" content="https://weixin.qq.com/sph/Other"><meta property="og:video" content="${video}">`, share);
  assert.equal(wrong.blocked, "unavailable");
  assert.deepEqual(wrong.videos, []);
  const ambiguous = extractWechatChannelsHtml(`<main><video src="${video}"></video><video src="https://example.com/second.mp4"></video></main>`, share);
  assert.equal(ambiguous.blocked, "unavailable");
  assert.deepEqual(ambiguous.videos, []);
});

test("Channels: malformed metadata identities and multiple content roots are unavailable rather than throwing or selecting a different video", () => {
  const malformed = extractWechatChannelsHtml(`<meta property="og:url" content="http://["><meta property="og:video" content="${video}">`, share);
  assert.equal(malformed.blocked, "unavailable");
  assert.deepEqual(malformed.videos, []);
  const multiple = extractWechatChannelsHtml(`<meta property="og:video" content="${video}"><article><video src="${video}"></video></article><article><video src="https://example.com/other.mp4"></video></article>`, share);
  assert.equal(multiple.blocked, "unavailable");
  assert.deepEqual(multiple.videos, []);
});

test("Channels: refuses private URLs, credentials, blob, HLS and encrypted media", () => {
  for (const source of ["http://127.0.0.1/video.mp4", "https://user:pass@example.com/video.mp4", "blob:https://weixin.qq.com/id", "https://example.com/master.m3u8"]) {
    assert.deepEqual(extractWechatChannelsHtml(`<main><video src="${source}"></video></main>`, share).videos, []);
  }
  const encrypted = extractWechatChannelsHtml(`<main><video src="${video}" data-decode-key="12345"></video></main>`, share);
  assert.equal(encrypted.blocked, "unavailable");
  assert.match(encrypted.reason ?? "", /加密/);
  assert.deepEqual(encrypted.videos, []);
});

test("Channels: distinguishes a QR/login gate and a client-only shell from readable video descriptions", () => {
  assert.equal(extractWechatChannelsHtml("<body><h1>扫码登录</h1><p>请使用微信扫码查看</p></body>", share).blocked, "login_required");
  const shell = extractWechatChannelsHtml("<body><h1>微信视频号</h1><p>请在微信客户端打开</p></body>", share);
  assert.equal(shell.blocked, "unavailable");
  const readable = extractWechatChannelsHtml(`<main><p class="description">本文介绍扫码登录流程。</p><video src="${video}"></video></main>`, share);
  assert.equal(readable.blocked, undefined);
  assert.deepEqual(readable.videos, [video]);
});

test("Channels: saves the direct MP4 only after video-stream validation and emits durable checkpoints", async t => {
  const context = await setup(t);
  const checkpoints: number[] = [];
  t.mock.method(globalThis, "fetch", async () => new Response(Uint8Array.of(1, 2, 3, 4), { headers: { "content-type": "video/mp4" } }));
  const captured = await acquireWechatChannels(input, { ...context, onCheckpoint: async record => { checkpoints.push(record.assets.length); } }, {
    captureWechatChannels: async () => ({ finalUrl: share, title: "测试视频", author: "作者", body: "原始描述", videos: [video] }),
    probeMedia: async file => { assert.equal(await fs.readFile(file).then(data => data.length), 4); return { video: true, audio: true }; }
  });
  assert.equal(captured.kind, "video");
  assert.equal(captured.title, "测试视频");
  assert.equal(captured.markdown, "原始描述");
  assert.deepEqual(captured.assets.map(asset => [asset.role, asset.status, asset.path]), [["video", "saved", "video/001.mp4"]], JSON.stringify(captured.assets));
  assert.match(captured.coverage?.media ?? "", /saved.*verified/);
  assert.deepEqual(checkpoints, [0, 1]);
});

test("Channels: rejects a saved-looking response that has no valid video stream", async t => {
  const context = await setup(t);
  t.mock.method(globalThis, "fetch", async () => new Response("encrypted or corrupt bytes", { headers: { "content-type": "video/mp4" } }));
  const captured = await acquireWechatChannels(input, context, {
    captureWechatChannels: async () => ({ finalUrl: share, title: "", body: "", videos: [video] }),
    probeMedia: async () => ({ video: false, audio: false })
  });
  assert.equal(captured.assets[0]?.status, "unavailable", JSON.stringify(captured.assets));
  assert.match(captured.assets[0]?.reason ?? "", /视频流/);
  assert.equal(contentStatus(captured), "failed");
});

test("Channels: reports unavailable when stream validation is unavailable", async t => {
  const context = await setup(t);
  t.mock.method(globalThis, "fetch", async () => new Response(Uint8Array.of(1), { headers: { "content-type": "video/mp4" } }));
  const captured = await acquireWechatChannels(input, context, {
    captureWechatChannels: async () => ({ finalUrl: share, title: "", body: "", videos: [video] }),
    probeMedia: async () => undefined
  });
  assert.equal(captured.assets[0]?.status, "unavailable", JSON.stringify(captured.assets));
  assert.match(captured.assets[0]?.reason ?? "", /验证/);
  assert.equal(contentStatus(captured), "failed");
});

test("Channels: default HTTP capture does not save an empty client shell as article content", async t => {
  const context = await setup(t);
  t.mock.method(globalThis, "fetch", async () => new Response("<html><title>微信视频号</title><body>请在微信客户端打开</body></html>", { headers: { "content-type": "text/html" } }));
  const captured = await acquireWechatChannels(input, context);
  assert.equal(captured.kind, "video");
  assert.equal(captured.markdown, "");
  assert.equal(captured.assets[0]?.role, "video");
  assert.equal(captured.assets[0]?.status, "unavailable");
  assert.match(captured.assets[0]?.reason ?? "", /微信客户端/);
  assert.equal(contentStatus(captured), "failed");
});

test("Channels: login gate cannot leak into markdown or masquerade as a saved video", async t => {
  const context = await setup(t);
  t.mock.method(globalThis, "fetch", async () => new Response("<html><body><h1>扫码登录</h1></body></html>", { headers: { "content-type": "text/html" } }));
  const captured = await acquireWechatChannels(input, context);
  assert.equal(captured.markdown, "");
  assert.equal(captured.assets[0]?.status, "login_required");
  assert.equal(captured.coverage?.media, "login_required");
});

test("Channels: rejects private redirects and private injected media before making those requests", async t => {
  const context = await setup(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }); });
  const redirected = await acquireWechatChannels(input, context);
  assert.equal(redirected.assets[0]?.status, "failed");
  assert.equal(calls, 1);
  const privateMedia = await acquireWechatChannels(input, context, {
    captureWechatChannels: async () => ({ finalUrl: share, title: "", body: "", videos: ["http://127.0.0.1/video.mp4"] })
  });
  assert.equal(privateMedia.assets[0]?.status, "unavailable");
  assert.equal(calls, 1);
});

test("Channels: bounds HTML response size and respects cancellation before network capture", async t => {
  const context = await setup(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("x", { headers: { "content-type": "text/html", "content-length": "8388609" } }); });
  const captured = await acquireWechatChannels(input, context);
  assert.equal(captured.assets[0]?.status, "failed");
  assert.match(captured.assets[0]?.reason ?? "", /上限/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(acquireWechatChannels(input, { ...context, signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("Channels: parser profile uses only data.feedInfo and prefers h264 over h265 and fallback", () => {
  const parsed = extractWechatChannelsProfile({ errCode: 0, data: {
    feedInfo: { description: "视频正文及标题", h264VideoInfo: { videoUrl: video }, h265VideoInfo: { videoUrl: "https://example.com/hevc.mp4" }, videoUrl: "https://example.com/fallback.mp4" },
    authorInfo: { nickname: "视频作者" }, recommendation: { videoUrl: "https://example.com/unrelated.mp4" }
  } }, share);
  assert.equal(parsed.title, "视频正文及标题");
  assert.equal(parsed.author, "视频作者");
  assert.equal(parsed.body, "视频正文及标题");
  assert.deepEqual(parsed.videos, [video]);
  assert.deepEqual(extractWechatChannelsProfile({ data: { feedInfo: { h265VideoInfo: { videoUrl: "https://example.com/hevc.mp4" } } } }, share).videos, ["https://example.com/hevc.mp4"]);
});

test("Channels: parser profile rejects malformed schemas, service errors and explicit encrypted URLs", () => {
  for (const profile of [null, [], { data: { videos: [video] } }, { errCode: 1001, errMsg: "分享已失效" }, { data: { feedInfo: { videoUrl: video, decodeKey: "12345" } } }]) {
    const parsed = extractWechatChannelsProfile(profile, share);
    assert.deepEqual(parsed.videos, []);
    assert.equal(parsed.blocked, "unavailable");
    assert.ok(parsed.reason);
  }
});

test("Channels: explicit parser sends only the normalized share URL as JSON with no cookies or authorization", async t => {
  const context = await setup(t);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url) === "https://parser.example.com/parse") return new Response(JSON.stringify({ errCode: 0, data: { feedInfo: { description: "公开描述", h264VideoInfo: { videoUrl: video } }, authorInfo: { nickname: "作者" } } }), { headers: { "content-type": "application/json" } });
    return new Response(Uint8Array.of(1, 2, 3), { headers: { "content-type": "video/mp4" } });
  });
  const captured = await acquireWechatChannels({ ...input, url: `${share}?session=private#fragment` }, context, {
    parserEndpoint: "https://parser.example.com/parse", probeMedia: async () => ({ video: true, audio: true })
  });
  assert.equal(captured.title, "公开描述");
  assert.equal(captured.assets[0]?.status, "saved", JSON.stringify(captured.assets));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { url: share });
  assert.equal(calls[0].init?.credentials, "omit");
  assert.equal(new Headers(calls[0].init?.headers).has("cookie"), false);
  assert.equal(new Headers(calls[0].init?.headers).has("authorization"), false);
});

test("Channels: parser is disabled by default and rejects private or insecure opt-in endpoints", async t => {
  const context = await setup(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("<body>请在微信客户端打开</body>", { headers: { "content-type": "text/html" } }); });
  await acquireWechatChannels(input, context, { parserEndpoint: null });
  assert.equal(calls, 1);
  for (const endpoint of ["http://parser.example.com/parse", "https://127.0.0.1/parse", "https://user:pass@parser.example.com/parse"]) {
    const record = await acquireWechatChannels(input, context, { parserEndpoint: endpoint });
    assert.equal(record.assets[0]?.status, "failed");
  }
  assert.equal(calls, 1);
});

test("Channels: provider errors and non-JSON responses are bounded and cannot report saved content", async t => {
  const context = await setup(t);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ errCode: 3, errMsg: "分享链接已失效" }), { headers: { "content-type": "application/json" } }));
  const error = await acquireWechatChannels(input, context, { parserEndpoint: "https://parser.example.com/parse" });
  assert.equal(error.assets[0]?.status, "unavailable");
  assert.match(error.assets[0]?.reason ?? "", /失效/);
  assert.equal(contentStatus(error), "failed");
  t.mock.method(globalThis, "fetch", async () => new Response("<html>wrong</html>", { status: 502 }));
  const nonJson = await acquireWechatChannels(input, context, { parserEndpoint: "https://parser.example.com/parse" });
  assert.equal(nonJson.assets[0]?.status, "failed");
  assert.match(nonJson.assets[0]?.reason ?? "", /502/);
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "1048577" } }));
  const oversized = await acquireWechatChannels(input, context, { parserEndpoint: "https://parser.example.com/parse" });
  assert.equal(oversized.assets[0]?.status, "failed");
  assert.match(oversized.assets[0]?.reason ?? "", /上限/);
});

test("Channels: a service credential is sent only to the opted-in parser and never to the video host", async t => {
  const context=await setup(t);
  const requests: Array<{url:string;headers:Headers}>=[];
  t.mock.method(globalThis,"fetch",async (url:string|URL,init?:RequestInit)=>{
    requests.push({url:String(url),headers:new Headers(init?.headers)});
    if(String(url)==="https://parser.example.com/parse")return new Response(JSON.stringify({data:{feedInfo:{description:"原视频",videoUrl:video}}}),{headers:{"content-type":"application/json"}});
    return new Response(Uint8Array.of(1,2,3),{headers:{"content-type":"video/mp4"}});
  });
  const record=await acquireWechatChannels(input,context,{parserEndpoint:"https://parser.example.com/parse",parserCredential:"PLACEHOLDER",probeMedia:async()=>({video:true})});
  assert.equal(record.assets[0].status,"saved");
  assert.equal(requests[0].headers.get("authorization"),"Bearer PLACEHOLDER");
  assert.equal(requests[1].headers.has("authorization"),false);assert.equal(requests[1].headers.has("cookie"),false);
  assert.doesNotMatch(JSON.stringify(record),/PLACEHOLDER/);
});

test("Channels: unauthorized parser responses explain the required service credential without saving a page shell", async t => {
  const context=await setup(t);
  t.mock.method(globalThis,"fetch",async()=>new Response(JSON.stringify({error:"unauthorized"}),{status:401,headers:{"content-type":"application/json"}}));
  const record=await acquireWechatChannels(input,context,{parserEndpoint:"https://parser.example.com/parse"});
  assert.equal(contentStatus(record),"failed");assert.equal(record.assets[0].status,"failed");assert.match(record.assets[0].reason??"",/401.*服务访问凭证/);
});

test("Channels: a parser error echo cannot persist its service credential", async t => {
  const context=await setup(t);
  t.mock.method(globalThis,"fetch",async()=>new Response(JSON.stringify({errCode:1,errMsg:"Authorization: Bearer PLACEHOLDER_SERVICE_CREDENTIAL"}),{headers:{"content-type":"application/json"}}));
  const record=await acquireWechatChannels(input,context,{parserEndpoint:"https://parser.example.com/parse",parserCredential:"PLACEHOLDER_SERVICE_CREDENTIAL"});
  assert.doesNotMatch(JSON.stringify(record),/PLACEHOLDER_SERVICE_CREDENTIAL/);
  assert.doesNotMatch(JSON.stringify(extractWechatChannelsProfile({errCode:1,errMsg:"Authorization: Bearer PLACEHOLDER_SERVICE_CREDENTIAL"},share)),/PLACEHOLDER_SERVICE_CREDENTIAL/);
});

test("Channels: the anonymous resolver saves its H264 video and sends only the share link", async t => {
  const context = await setup(t);
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    if (String(url) === "https://v.mtotech.com/api/resolve") return new Response(JSON.stringify({ ok: true, data: {
      author: "原视频作者", description: "原始简介", h264_url: video, h265_url: "https://example.com/hevc.mp4",
      cover_url: "https://example.com/cover.jpg", author_icon: "https://example.com/avatar.jpg", recommendation: { h264_url: "https://example.com/other.mp4" }
    } }), { headers: { "content-type": "application/json" } });
    return new Response(Uint8Array.of(1, 2, 3), { headers: { "content-type": "video/mp4" } });
  });
  const record = await acquireWechatChannels({ ...input, url: `${share}?session=private#fragment` }, context, {
    parserEndpoint: "https://v.mtotech.com/api/resolve", parserCredential: "PLACEHOLDER_UNRELATED_CREDENTIAL", probeMedia: async () => ({ video: true, audio: true })
  });
  assert.equal(record.title, "原始简介");
  assert.equal(record.author, "原视频作者");
  assert.equal(record.markdown, "原始简介");
  assert.equal(record.assets[0]?.status, "saved", JSON.stringify(record.assets));
  assert.deepEqual(requests.map(request => request.url), ["https://v.mtotech.com/api/resolve", video]);
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { url: share });
  assert.equal(requests[0].init?.method, "POST");
  assert.equal(requests[0].init?.credentials, "omit");
  for (const request of requests) {
    assert.equal(new Headers(request.init?.headers).has("cookie"), false);
    assert.equal(new Headers(request.init?.headers).has("authorization"), false);
  }
  assert.doesNotMatch(JSON.stringify(record), /PLACEHOLDER_UNRELATED_CREDENTIAL/);
});

test("Channels: anonymous resolver failures cannot reuse stale media from an unsuccessful response", async t => {
  const context = await setup(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ ok: false, error: "分享链接已失效", data: { h264_url: video } }), { headers: { "content-type": "application/json" } });
  });
  const record = await acquireWechatChannels(input, context, { parserEndpoint: "https://v.mtotech.com/api/resolve" });
  assert.equal(record.assets[0]?.status, "unavailable");
  assert.match(record.assets[0]?.reason ?? "", /失效/);
  assert.equal(calls, 1);
});

test("Channels: anonymous resolver refuses missing, private, playlist and encrypted media without downloading them", async t => {
  const context = await setup(t);
  let calls = 0; let profile: unknown;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify(profile), { headers: { "content-type": "application/json" } });
  });
  for (const data of [null, [], {}, { h264_url: "http://127.0.0.1/private.mp4" }, { h264_url: "https://user:pass@example.com/private.mp4" }, { h264_url: "https://example.com/live.m3u8" }, { h264_url: video, decodeKey: "123" }]) {
    calls = 0; profile = { ok: true, data };
    const record = await acquireWechatChannels(input, context, { parserEndpoint: "https://v.mtotech.com/api/resolve" });
    assert.equal(record.assets[0]?.status, "unavailable");
    assert.equal(calls, 1);
    if (data && !Array.isArray(data) && "decodeKey" in data) assert.match(record.assets[0]?.reason ?? "", /加密/);
  }
  for (const ok of ["true", 1, undefined]) {
    calls = 0; profile = { ok, data: { h264_url: video } };
    const record = await acquireWechatChannels(input, context, { parserEndpoint: "https://v.mtotech.com/api/resolve" });
    assert.equal(record.assets[0]?.status, "unavailable");
    assert.equal(calls, 1);
  }
});

test("Channels: resolver H265 fallback is scoped to the known provider contract", async t => {
  const context = await setup(t);
  t.mock.method(globalThis, "fetch", async (url: string | URL) => String(url).includes("/api/resolve")
    ? new Response(JSON.stringify({ ok: true, data: { description: "只有H265", h265_url: video } }), { headers: { "content-type": "application/json" } })
    : new Response(Uint8Array.of(1, 2, 3), { headers: { "content-type": "video/mp4" } }));
  const valid = await acquireWechatChannels(input, context, { parserEndpoint: "https://v.mtotech.com/api/resolve", probeMedia: async () => ({ video: true }) });
  assert.equal(valid.assets[0]?.status, "saved");
  const unknown = await acquireWechatChannels(input, context, { parserEndpoint: "https://parser.example.com/api/resolve", probeMedia: async () => ({ video: true }) });
  assert.equal(unknown.assets[0]?.status, "unavailable");
});

test("Channels: an anonymous resolver rejection reports the service error without requesting credentials", async t => {
  const context = await setup(t);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: false, error: "服务暂时拒绝解析" }), { status: 403, headers: { "content-type": "application/json" } }));
  const record = await acquireWechatChannels(input, context, { parserEndpoint: "https://v.mtotech.com/api/resolve" });
  assert.equal(record.assets[0]?.status, "failed");
  assert.match(record.assets[0]?.reason ?? "", /403.*拒绝解析/);
  assert.doesNotMatch(record.assets[0]?.reason ?? "", /访问凭证|Cookie/);
});

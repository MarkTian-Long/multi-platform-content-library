import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { acquireWeibo as acquireWeiboImplementation, type WeiboDeps } from "../src/content-weibo.js";
import { weiboPostReference } from "../src/content-social-reference.js";
import { contentStatus } from "../src/content-library.js";
import { SocialBrowserError } from "../src/content-social-browser.js";
import type { ContentInput, ContentContext, CapturedContent } from "../src/content-types.js";

const bid = "N4xlMvjhI", mid = "4910815147462302";
const root = path.join(process.cwd(), "logs/douyin-weibo-20261014/weibo/unit");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL+XQAAAABJRU5ErkJggg==", "base64");
const post = (extra: Record<string, unknown> = {}) => ({ idstr: mid, mblogid: bid, text_raw: "原帖完整正文，保留限定词。", user: { idstr: "7827771738", screen_name: "作者", avatar_hd: "https://wx1.sinaimg.cn/avatar.jpg" }, ...extra });
const input = (url = `https://weibo.com/7827771738/${bid}`): ContentInput => ({ url, platform: "weibo", ...weiboPostReference(url)! });
// Unit fixtures never open a real persistent browser profile.
const acquireWeibo = (value: ContentInput, ctx: ContentContext, injected: WeiboDeps = {}) => acquireWeiboImplementation(value, ctx, { captureBrowser: async target => ({ finalUrl: target.canonicalUrl, html: "", responses: [], gated: false }), ...injected });
const showUrl = (value = bid) => `https://weibo.com/ajax/statuses/show?id=${value}`;
async function context(t: TestContext): Promise<ContentContext> {
  await fs.mkdir(root, { recursive: true }); const directory = await fs.mkdtemp(path.join(root, "case-"));
  t.after(async () => { assert.ok(path.relative(root, directory).startsWith("case-")); await fs.rm(directory, { recursive: true, force: true }); });
  return { runtimeRoot: directory, directory };
}
function deps(value: unknown, saved: string[] = []): WeiboDeps {
  return {
    requestJson: async () => value,
    saveAsset: async (url, directory, stem, role) => {
      saved.push(url); const bytes = role === "image" ? png : Buffer.from("local video fixture");
      const relative = stem + (role === "image" ? ".png" : ".mp4");
      await fs.mkdir(path.dirname(path.join(directory, relative)), { recursive: true }); await fs.writeFile(path.join(directory, relative), bytes);
      return { id: stem, role, status: "saved", path: relative, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mime: role === "image" ? "image/png" : "video/mp4", provenance: "original" };
    },
    probeMedia: async () => ({ video: true, audio: true, durationSeconds: 5 })
  };
}

test("Weibo reads only the exact post body/images and excludes retweet, avatar, comments and recommendations", async t => {
  const ctx = await context(t), saved: string[] = [];
  const data = post({ pic_ids: ["own"], pic_infos: { own: { largest: { url: "https://wx1.sinaimg.cn/large/own.png" } }, unrelated: { largest: { url: "https://wx1.sinaimg.cn/large/not-own.png" } } }, pic_num: 1, retweeted_status: { ...post(), text_raw: "原博其他正文", pics: [{ url: "https://wx1.sinaimg.cn/retweet.png" }] }, comments: [post()], recommend: [{ ...post(), pics: [{ url: "https://wx1.sinaimg.cn/recommend.png" }] }] });
  const result = await acquireWeibo(input(), ctx, deps(data, saved));
  assert.equal(result.platform, "weibo"); assert.equal(result.nativeId, bid);
  assert.match(result.markdown, /原帖完整正文/); assert.doesNotMatch(result.markdown, /原博其他正文/);
  assert.deepEqual(saved, ["https://wx1.sinaimg.cn/large/own.png"]);
  assert.equal(result.assets.filter(a => a.role === "image" && a.status === "saved").length, 1);
});

test("Weibo numeric MID aliases keep the exact canonical BID identity", async t => {
  const ctx = await context(t), result = await acquireWeibo(input(`https://m.weibo.cn/detail/${mid}`), ctx, deps({ ok: 1, data: post() }));
  assert.equal(result.nativeId, bid); assert.equal(result.canonicalUrl, `https://m.weibo.cn/status/${bid}`);
});

test("Weibo rejects wrong or contradictory metadata identity before downloading any asset", async t => {
  const ctx = await context(t), saved: string[] = [];
  for (const value of [post({ mblogid: "FBqgOmDxO" }), post({ idstr: "4189191225395228" }), { ok: 1, data: { cards: [post()] } }]) {
    const result = await acquireWeibo(input(), ctx, deps(value, saved));
    assert.equal(result.assets.some(a => a.status === "saved"), false); assert.equal(result.markdown, "");
  }
  assert.deepEqual(saved, []);
});

test("Weibo retrieves long text through an exact-bound extension instead of claiming a teaser is full", async t => {
  const ctx = await context(t), requests: string[] = [];
  const result = await acquireWeibo(input(), ctx, { requestJson: async url => { requests.push(url); return url.includes("longtext") ? { ok: 1, data: { longTextContent: "<p>完整的长文第一段。</p><p>结尾限定语不能丢。</p>" } } : post({ isLongText: true, text_raw: "截断简介..." }); } });
  assert.match(result.markdown, /结尾限定语不能丢/); assert.doesNotMatch(result.markdown, /截断简介/);
  assert.ok(requests.some(url => url.includes("longtext")));
  assert.equal(result.coverage?.body, "saved: full post text");
});

test("Weibo failed long-text extension retains the teaser but marks body incomplete", async t => {
  const ctx = await context(t);
  const result = await acquireWeibo(input(), ctx, { requestJson: async url => url.includes("statuses/show") ? post({ isLongText: true, text_raw: "截断简介..." }) : { ok: 0 } });
  assert.match(result.markdown, /截断简介/); assert.ok(result.warnings.some(w => /长文|完整/.test(w)));
  assert.notEqual(result.coverage?.body, "saved: full post text"); assert.equal(contentStatus(result), "partial");
});

test("Weibo long-text declarations must all agree with the exact requested post", async t => {
  const ctx = await context(t);
  for (const identity of [{ mblogid: bid, idstr: "4189191225395228" }, { mid: "invalid" }, { bid: null }, { mblogid: bid, id: Number.MAX_SAFE_INTEGER + 2 }]) {
    const result = await acquireWeibo(input(), ctx, { requestJson: async url => url.includes("statuses/show") ? post({ isLongText: true, text_raw: "原帖片段" }) : { ok: 1, data: { ...identity, longTextContent: "其他帖子的长文" } } });
    assert.equal(result.markdown, "原帖片段"); assert.notEqual(result.coverage?.body, "saved: full post text");
  }
});

test("Weibo valid JSON containing challenge words remains ordinary original text", async t => {
  const ctx = await context(t), text = "讨论验证码与安全验证的正常原帖。";
  const result = await acquireWeibo(input(), ctx, { fetch: async () => new Response(JSON.stringify(post({ text_raw: text })), { headers: { "content-type": "application/json" } }) });
  assert.equal(result.markdown, text); assert.equal(result.assets.some(a => a.status === "login_required"), false);
  const challenge = await acquireWeibo(input(), ctx, { fetch: async () => new Response('<html><input name="captcha">验证码</html>', { headers: { "content-type": "text/html" } }), captureBrowser: async target => ({ finalUrl: target.canonicalUrl, html: "", responses: [], gated: true }) });
  assert.equal(challenge.markdown, ""); assert.ok(challenge.assets.some(a => a.status === "login_required"));
});

test("Weibo normal guarded visitor JSONP is parsed as data and guest cookies stay ephemeral", async t => {
  const ctx = await context(t); let attempts = 0, visitorCalls = 0;
  const result = await acquireWeibo(input(), ctx, { fetch: async (url, init) => {
    if (String(url).includes("/visitor/genvisitor")) return new Response('window.gen_callback && gen_callback({"retcode":20000000,"data":{"tid":"fixture-tid","new_tid":true,"confidence":100}});');
    if (String(url).includes("/visitor/visitor")) { visitorCalls++; return new Response('cross_domain({"retcode":20000000});', { headers: { "set-cookie": "SUB=guest-fixture; Domain=.weibo.com; Path=/; Secure; HttpOnly" } }); }
    if (++attempts === 1) { const response = new Response("<html>visitor bootstrap</html>"); Object.defineProperty(response, "url", { value: "https://passport.weibo.com/visitor/visitor?from=weibo" }); return response; }
    assert.equal(new Headers(init?.headers).get("cookie"), "SUB=guest-fixture");
    return new Response(JSON.stringify(post()), { headers: { "content-type": "application/json" } });
  } });
  assert.equal(result.markdown, post().text_raw); assert.equal(attempts, 2); assert.equal(visitorCalls, 1);
  await assert.rejects(fs.stat(path.join(ctx.runtimeRoot, ".content-profile/weibo/cookies.txt")), { code: "ENOENT" });
});

test("Weibo video is marked saved only after the shared download and local stream/duration probe", async t => {
  const ctx = await context(t), saved: string[] = [];
  const data = post({ page_info: { type: "video", object_id: "1034:4797699866951785", media_info: { duration: 5, playback_list: [{ play_info: { url: "https://f.video.weibocdn.com/own.mp4?token=private", mime: "video/mp4", width: 640, height: 360 } }] } } });
  const result = await acquireWeibo(input(), ctx, deps(data, saved));
  assert.equal(result.kind, "video"); assert.ok(result.assets.some(a => a.role === "video" && a.status === "saved"));
  assert.equal(result.parts?.[0].durationSeconds, 5); assert.equal(saved.length, 1);
  const failed = await acquireWeibo(input(), ctx, { ...deps(data), probeMedia: async () => ({ video: false, audio: true, durationSeconds: 5 }) });
  assert.equal(failed.assets.some(a => a.role === "video" && a.status === "saved"), false);
});

test("Weibo default probe forces the MP4 demuxer and disables external data references", async t => {
  const ctx = await context(t), data = post({ page_info: { type: "video", media_info: { duration: 5, stream_url: "https://f.video.weibocdn.com/own.mp4" } } });
  const injected = deps(data); delete injected.probeMedia;
  injected.runTool = async (_command, args) => {
    assert.deepEqual(args.slice(0, 10), ["-protocol_whitelist", "file,pipe", "-v", "error", "-f", "mov", "-enable_drefs", "0", "-use_absolute_path", "0"]);
    return { code: 0, stdout: JSON.stringify({ streams: [{ codec_type: "video" }], format: { duration: "5" } }), stderr: "", timedOut: false, cancelled: false, outputTruncated: false };
  };
  const result = await acquireWeibo(input(), ctx, injected);
  assert.ok(result.assets.some(a => a.role === "video" && a.status === "saved"));
});

test("Weibo rejects a truncated two-second video and preserves the existing good file before manifest merge", async t => {
  const ctx = await context(t), data = post({ page_info: { type: "video", object_id: "1034:4797699866951785", media_info: { duration: 2, stream_url: "https://f.video.weibocdn.com/own.mp4" } } });
  const good = await acquireWeibo(input(), ctx, { ...deps(data), probeMedia: async () => ({ video: true, audio: true, durationSeconds: 2 }) });
  const prior = good.assets.find(a => a.status === "saved")!; assert.ok(prior.path);
  const before = await fs.readFile(path.join(ctx.directory, prior.path!)); ctx.existing = good;
  const changed = deps(data), originalSave = changed.saveAsset!;
  changed.saveAsset = async (...args) => { const asset = await originalSave(...args), bytes = Buffer.from("truncated replacement bytes"); await fs.writeFile(path.join(args[1], asset.path!), bytes); return { ...asset, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }; };
  changed.probeMedia = async () => ({ video: true, audio: true, durationSeconds: 0.1 });
  const result = await acquireWeibo(input(), ctx, changed);
  assert.equal(result.assets.some(a => a.role === "video" && a.status === "saved"), false);
  assert.deepEqual(await fs.readFile(path.join(ctx.directory, prior.path!)), before);
  assert.deepEqual(await fs.readdir(path.join(ctx.directory, ".weibo-downloads")), []);
});

test("Weibo invalid image bytes cannot overwrite the previous verified image", async t => {
  const ctx = await context(t), data = post({ pics: [{ url: "https://wx1.sinaimg.cn/own.png" }] });
  const good = await acquireWeibo(input(), ctx, deps(data)), prior = good.assets.find(a => a.status === "saved")!;
  const before = await fs.readFile(path.join(ctx.directory, prior.path!)); ctx.existing = good;
  const changed = deps(data), originalSave = changed.saveAsset!;
  changed.saveAsset = async (...args) => { const asset = await originalSave(...args), bytes = Buffer.from("<html>expired image</html>"); await fs.writeFile(path.join(args[1], asset.path!), bytes); return { ...asset, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }; };
  const result = await acquireWeibo(input(), ctx, changed);
  assert.equal(result.assets.some(a => a.status === "saved"), false); assert.deepEqual(await fs.readFile(path.join(ctx.directory, prior.path!)), before);
});

test("Weibo refuses private, credential, playlist and undeclared-media URLs", async t => {
  const ctx = await context(t), saved: string[] = [];
  for (const url of ["http://127.0.0.1/a.mp4", "https://user:pass@f.video.weibocdn.com/a.mp4", "https://f.video.weibocdn.com/a.m3u8"]) {
    const result = await acquireWeibo(input(), ctx, deps(post({ page_info: { type: "video", object_id: "1034:4797699866951785", media_info: { stream_url: url } } }), saved));
    assert.equal(result.assets.some(a => a.role === "video" && a.status === "saved"), false);
  }
  const article = await acquireWeibo(input(), ctx, deps(post({ page_info: { type: "webpage", media_info: { stream_url: "https://f.video.weibocdn.com/ad.mp4" } } }), saved));
  assert.equal(article.assets.some(a => a.role === "video"), false); assert.equal(saved.length, 0);
});

test("Weibo skips retweeted post video even when a root preview mirrors the original", async t => {
  const ctx = await context(t), saved: string[] = [], page = { type: "video", object_id: "1034:4797699866951785", media_info: { stream_url: "https://f.video.weibocdn.com/forward.mp4" } };
  const result = await acquireWeibo(input(), ctx, deps(post({ page_info: page, retweeted_status: { ...post(), page_info: page } }), saved));
  assert.equal(result.assets.some(a => a.role === "video" && a.status === "saved"), false); assert.equal(saved.length, 0);
});

test("Weibo TV preserves video:FID identity and selects only the exact video among mixed attachments", async t => {
  const ctx = await context(t), fid = "1034:4797699866951785", saved: string[] = [];
  const target = { object_id: fid, media_info: { duration: 5, stream_url: "https://f.video.weibocdn.com/target.mp4" } };
  const other = { object_id: "1034:4967272104787984", media_info: { duration: 5, stream_url: "https://f.video.weibocdn.com/recommend.mp4" } };
  const d = deps({}, saved); d.requestJson = async url => url.includes("component") ? { code: "100000", data: { Component_Play_Playinfo: { oid: fid, mid } } } : post({ mix_media_info: { items: [{ type: "video", data: other }, { type: "video", data: target }] } });
  const result = await acquireWeibo(input(`https://weibo.com/tv/show/${fid}`), ctx, d);
  assert.equal(result.nativeId, `video:${fid}`); assert.deepEqual(saved, ["https://f.video.weibocdn.com/target.mp4"]);
});

test("Weibo login-required response never manufactures text or media success", async t => {
  const ctx = await context(t), result = await acquireWeibo(input(), ctx, { requestJson: async () => ({ ok: 0, errno: "21301", msg: "need login" }), captureBrowser: async target => ({ finalUrl: target.canonicalUrl, html: "", responses: [], gated: true }) });
  assert.equal(result.markdown, ""); assert.ok(result.assets.some(a => a.status === "login_required"));
});

test("Weibo cancellation retains a saved checkpoint and stops subsequent media", async t => {
  const ctx = await context(t), controller = new AbortController(), saved: string[] = [], checkpoints: CapturedContent[] = [];
  ctx.signal = controller.signal; ctx.onCheckpoint = async record => { checkpoints.push(structuredClone(record)); if (record.assets.some(a => a.status === "saved")) controller.abort(); };
  const d = deps(post({ pics: [{ url: "https://wx1.sinaimg.cn/a.png" }, { url: "https://wx1.sinaimg.cn/b.png" }] }), saved);
  const result = await acquireWeibo(input(), ctx, d);
  assert.equal(saved.length, 1); assert.equal(result.assets.filter(a => a.status === "saved").length, 1); assert.ok(checkpoints.length);
});

test("Weibo falls back from anonymous API failure to exact-post browser JSON and shared original image saving", async t => {
  const ctx = await context(t), saved: string[] = []; let captures = 0;
  const own = post({ pics: [{ url: "https://wx1.sinaimg.cn/own.png" }], retweeted_status: { ...post(), text_raw: "原博正文", pics: [{ url: "https://wx1.sinaimg.cn/forward.png" }] } });
  const result = await acquireWeibo(input(), ctx, { ...deps({}, saved), requestJson: async () => ({ ok: 0, errno: "21301", msg: "need login" }), captureBrowser: async (target, _ctx, requests) => {
    captures++; assert.equal(target.platform, "weibo"); assert.equal(target.nativeId, bid);
    assert.ok(requests?.some(request => request.url === showUrl())); assert.ok(requests?.some(request => request.url.includes("longtext")));
    return { finalUrl: target.canonicalUrl, html: "正常渲染原帖", gated: false, responses: [{ url: showUrl(), data: own }] };
  } });
  assert.equal(captures, 1); assert.equal(result.markdown, post().text_raw); assert.equal(result.coverage?.acquisition, "saved: dedicated Edge official JSON");
  assert.deepEqual(saved, ["https://wx1.sinaimg.cn/own.png"]); assert.equal(contentStatus(result), "completed");
});

test("Weibo browser fallback rejects wrong page, wrong JSON post, or unrelated API URL before saving media", async t => {
  const ctx = await context(t), saved: string[] = [], foreign = "FBqgOmDxO";
  for (const snapshot of [
    { finalUrl: `https://m.weibo.cn/status/${foreign}`, responses: [{ url: showUrl(), data: post() }] },
    { finalUrl: input().canonicalUrl, responses: [{ url: showUrl(), data: post({ mblogid: foreign }) }] },
    { finalUrl: input().canonicalUrl, responses: [{ url: showUrl(foreign), data: post() }] },
    { finalUrl: input().canonicalUrl, responses: [{ url: `https://example.com/ajax/statuses/show?id=${bid}`, data: post() }] }
  ]) {
    const result = await acquireWeibo(input(), ctx, { ...deps({}, saved), requestJson: async () => ({ ok: 0 }), captureBrowser: async () => ({ ...snapshot, html: "", gated: false }) });
    assert.equal(result.markdown, ""); assert.equal(result.assets.some(a => a.status === "saved"), false);
  }
  assert.deepEqual(saved, []);
});

test("Weibo browser TV keeps input FID and uses only the exactly bound video", async t => {
  const ctx = await context(t), fid = "1034:4797699866951785", target = input(`https://weibo.com/tv/show/${fid}`), saved: string[] = [];
  const componentUrl = `https://weibo.com/tv/api/component?page=${encodeURIComponent(`/tv/show/${fid}`)}`;
  const own = post({ mix_media_info: { items: [
    { type: "video", data: { object_id: "1034:4967272104787984", media_info: { duration: 5, stream_url: "https://f.video.weibocdn.com/other.mp4" } } },
    { type: "video", data: { object_id: fid, media_info: { duration: 5, stream_url: "https://f.video.weibocdn.com/target.mp4" } } }
  ] } });
  const result = await acquireWeibo(target, ctx, { ...deps({}, saved), requestJson: async () => ({ ok: 0 }), captureBrowser: async (_input, _ctx, requests) => {
    assert.ok(requests?.some(request => request.url === componentUrl && request.method === "POST" && JSON.parse(new URLSearchParams(request.body).get("data")!).Component_Play_Playinfo.oid === fid));
    return { finalUrl: target.canonicalUrl, html: "", gated: false, responses: [{ url: componentUrl, data: { code: "100000", data: { Component_Play_Playinfo: { oid: fid, mid } } } }, { url: showUrl(), data: own }] };
  } });
  assert.equal(result.nativeId, `video:${fid}`); assert.equal(result.parts?.[0].status, "saved"); assert.deepEqual(saved, ["https://f.video.weibocdn.com/target.mp4"]);
});

test("Weibo browser TV refuses mismatched or contradictory FID declarations", async t => {
  const ctx = await context(t), fid = "1034:4797699866951785", target = input(`https://weibo.com/tv/show/${fid}`), saved: string[] = [], componentUrl = `https://weibo.com/tv/api/component?page=${encodeURIComponent(`/tv/show/${fid}`)}`;
  for (const identity of [{ oid: "1034:4967272104787984" }, { oid: fid, object_id: "1034:4967272104787984" }, { oid: "invalid" }]) {
    const result = await acquireWeibo(target, ctx, { ...deps({}, saved), requestJson: async () => ({ ok: 0 }), captureBrowser: async () => ({ finalUrl: target.canonicalUrl, html: "", gated: false, responses: [{ url: componentUrl, data: { code: "100000", data: { Component_Play_Playinfo: { ...identity, mid } } } }, { url: showUrl(), data: post() }] }) });
    assert.equal(result.markdown, ""); assert.equal(result.assets.some(a => a.status === "saved"), false);
  }
  assert.deepEqual(saved, []);
});

test("Weibo browser challenge and readable empty results never manufacture a successful post", async t => {
  const ctx = await context(t);
  const gated = await acquireWeibo(input(), ctx, { requestJson: async () => ({ ok: 0 }), captureBrowser: async target => ({ finalUrl: target.canonicalUrl, html: '<input name="captcha">', gated: true, responses: [] }) });
  assert.equal(gated.markdown, ""); assert.ok(gated.assets.some(a => a.status === "login_required"));
  const empty = await acquireWeibo(input(), ctx, { requestJson: async () => ({ ok: 0, errno: "21301", msg: "need login" }), captureBrowser: async target => ({ finalUrl: target.canonicalUrl, html: "正常页面讨论验证码", gated: false, responses: [] }) });
  assert.equal(empty.markdown, ""); assert.ok(empty.assets.some(a => a.status === "unavailable")); assert.equal(contentStatus(empty), "failed");
});

test("Weibo browser longtext completes an exact truncated post and rejects conflicting extension identities", async t => {
  const ctx = await context(t), targetPost = post({ isLongText: true, text_raw: "原帖片段" });
  for (const valid of [true, false]) {
    const result = await acquireWeibo(input(), ctx, { requestJson: async url => url.includes("statuses/show") ? targetPost : { ok: 0 }, captureBrowser: async target => ({ finalUrl: target.canonicalUrl, html: "", gated: false, responses: [{ url: `https://weibo.com/ajax/statuses/longtext?id=${bid}`, data: { ok: 1, data: { mblogid: bid, ...(valid ? {} : { idstr: "4189191225395228" }), longTextContent: "<p>完整长文与限定语。</p>" } } }] }) });
    assert.equal(result.markdown, valid ? "完整长文与限定语。" : "原帖片段");
    assert.equal(result.coverage?.body === "saved: full post text", valid);
  }
});

test("Weibo invalid browser replacement cannot overwrite an already verified original video", async t => {
  const ctx = await context(t), own = post({ page_info: { type: "video", object_id: "1034:4797699866951785", media_info: { duration: 2, stream_url: "https://f.video.weibocdn.com/own.mp4" } } });
  const prior = await acquireWeibo(input(), ctx, { ...deps(own), probeMedia: async () => ({ video: true, audio: true, durationSeconds: 2 }) });
  const old = prior.assets.find(a => a.status === "saved")!, before = await fs.readFile(path.join(ctx.directory, old.path!)); ctx.existing = prior;
  const injected = deps({}), originalSave = injected.saveAsset!;
  injected.requestJson = async () => ({ ok: 0 });
  injected.captureBrowser = async target => ({ finalUrl: target.canonicalUrl, html: "", gated: false, responses: [{ url: showUrl(), data: own }] });
  injected.saveAsset = async (...args) => { const asset = await originalSave(...args), bytes = Buffer.from("invalid new truncated bytes"); await fs.writeFile(path.join(args[1], asset.path!), bytes); return { ...asset, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }; };
  injected.probeMedia = async () => ({ video: true, audio: true, durationSeconds: 0.1 });
  const result = await acquireWeibo(input(), ctx, injected);
  assert.equal(result.assets.some(a => a.role === "video" && a.status === "saved"), false); assert.deepEqual(await fs.readFile(path.join(ctx.directory, old.path!)), before);
});

test("Weibo cancellation before Edge fallback never opens the profile", async t => {
  const ctx = await context(t), controller = new AbortController(); ctx.signal = controller.signal; let captures = 0;
  const result = await acquireWeibo(input(), ctx, { requestJson: async () => { controller.abort(); throw new Error("cancelled"); }, captureBrowser: async target => { captures++; return { finalUrl: target.canonicalUrl, html: "", gated: false, responses: [] }; } });
  assert.equal(captures, 0); assert.equal(result.markdown, ""); assert.equal(result.coverage?.media, "cancelled");
});

test("Weibo keeps already validated target JSON even when a later browser gate is visible", async t => {
  const ctx = await context(t);
  const result = await acquireWeibo(input(), ctx, { requestJson: async () => ({ ok: 0 }), captureBrowser: async () => ({ finalUrl: "https://passport.weibo.com/visitor/visitor", html: '<input name="captcha">', gated: true, responses: [{ url: showUrl(), data: post() }] }) });
  assert.equal(result.markdown, post().text_raw); assert.equal(result.assets.some(a => a.status === "login_required"), false); assert.equal(contentStatus(result), "completed");
});

test("Weibo browser full text_raw preserves literal angle brackets and original paragraph breaks", async t => {
  const ctx = await context(t), full = "第一段保留 <literal> 原词。\n第二段保留限定语。";
  const result = await acquireWeibo(input(), ctx, { requestJson: async url => url.includes("statuses/show") ? post({ isLongText: true, text_raw: "原帖片段" }) : { ok: 0 }, captureBrowser: async target => ({ finalUrl: target.canonicalUrl, html: "", gated: false, responses: [{ url: showUrl(), data: post({ isLongText: false, text_raw: full }) }] }) });
  assert.equal(result.markdown, full); assert.equal(result.coverage?.body, "saved: full post text");
});

test("Weibo does not open Edge when the official API already supplies complete target data", async t => {
  const ctx = await context(t); let captures = 0;
  const result = await acquireWeibo(input(), ctx, { ...deps(post()), captureBrowser: async target => { captures++; return { finalUrl: target.canonicalUrl, html: "", gated: false, responses: [] }; } });
  assert.equal(result.markdown, post().text_raw); assert.equal(captures, 0);
});

test("Weibo cancellation while the browser returns stops before any media download", async t => {
  const ctx = await context(t), controller = new AbortController(), saved: string[] = []; ctx.signal = controller.signal;
  const result = await acquireWeibo(input(), ctx, { ...deps({}, saved), requestJson: async () => ({ ok: 0 }), captureBrowser: async target => { controller.abort(); return { finalUrl: target.canonicalUrl, html: "", gated: false, responses: [{ url: showUrl(), data: post({ pics: [{ url: "https://wx1.sinaimg.cn/own.png" }] }) }] }; } });
  assert.deepEqual(saved, []); assert.equal(result.assets.some(a => a.status === "saved"), false); assert.equal(result.coverage?.media, "cancelled");
});

test("Weibo browser errors retain a redacted diagnostic and the helper dependency state", async t => {
  const ctx = await context(t);
  const result = await acquireWeibo(input(), ctx, { requestJson: async () => ({ ok: 0 }), captureBrowser: async () => { throw new SocialBrowserError("Edge 不可用：token=fixture_secret", "missing_dependency"); } });
  const failure = result.assets.find(a => a.role === "source")!;
  assert.equal(failure.status, "missing_dependency"); assert.match(failure.reason!, /Edge 不可用/); assert.doesNotMatch(failure.reason!, /fixture_secret/);
});

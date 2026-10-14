import test from "node:test";
import assert from "node:assert/strict";
import { promises as dns } from "node:dns";
import { parseContentLinks, resolveContentInput } from "../src/content-input.js";

test("parses Chinese share text, removes trailing punctuation, keeps access URLs, and deduplicates identities", () => {
  const links = parseContentLinks(`推荐阅读：微信 https://mp.weixin.qq.com/s/abc?__biz=x&key=private-token。\n小红书 https://www.xiaohongshu.com/explore/66aa11bb22cc33dd44ee55ff，\nB站 BV1xx411c7mD https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=333.1`);
  assert.equal(links.length, 3);
  assert.deepEqual(links.map((link) => link.platform), ["wechat", "xiaohongshu", "bilibili"]);
  assert.equal(links[0].url, "https://mp.weixin.qq.com/s/abc?__biz=x&key=private-token");
  assert.doesNotMatch(links[0].canonicalUrl, /private-token/);
  assert.equal(links[1].nativeId, "66aa11bb22cc33dd44ee55ff");
  assert.equal(links[2].nativeId, "BV1xx411c7mD");
});

test("rejects non-public URLs and embedded credentials", () => {
  const links = parseContentLinks("file:///C:/secret https://user:pass@example.com/a http://127.0.0.1/a https://[::1]/x javascript:alert(1) https://example.com/a");
  assert.deepEqual(links.map((link) => link.canonicalUrl), ["https://example.com/a"]);
});

test("recognizes a bare Bilibili BV identifier from a share message", () => {
  const links = parseContentLinks("今天的视频编号 BV1xx411c7mD，建议收藏。");
  assert.deepEqual(links, [{ platform: "bilibili", url: "https://www.bilibili.com/video/BV1xx411c7mD", canonicalUrl: "https://www.bilibili.com/video/BV1xx411c7mD", nativeId: "BV1xx411c7mD" }]);
});

test("keeps content identity query while stripping secrets and tracking, without trusting arbitrary platform-shaped paths", () => {
  const links = parseContentLinks("https://blog.example/video/BV1xx411c7mD?article=one&utm_source=share&token=secret https://mp.weixin.qq.com/s?__biz=biz&mid=12&idx=2&sn=secret");
  assert.equal(links[0].platform, "web");
  assert.equal(links[0].canonicalUrl, "https://blog.example/video/BV1xx411c7mD?article=one");
  assert.equal(links[1].canonicalUrl, "https://mp.weixin.qq.com/s?__biz=biz&mid=12&idx=2");
  assert.doesNotMatch(links[1].canonicalUrl, /secret/);
});

test("resolves a short link without moving a signed access URL into its canonical identity", async t => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => String(url).includes("b23.tv")
    ? new Response(null, { status: 302, headers: { location: "https://www.bilibili.com/video/BV1xx411c7mD/?token=private" } })
    : new Response("ok")) as typeof fetch;
  try {
    const resolved = await resolveContentInput(parseContentLinks("https://b23.tv/abc")[0]);
    assert.equal(resolved.url, "https://www.bilibili.com/video/BV1xx411c7mD/?token=private");
    assert.equal(resolved.canonicalUrl, "https://www.bilibili.com/video/BV1xx411c7mD");
    assert.equal(resolved.nativeId, "BV1xx411c7mD");
  } finally { globalThis.fetch = original; }
});

test("recognizes both Xiaohongshu short-link domains and keeps WeChat Channels separate from articles", () => {
  const inputs = parseContentLinks("https://xhslink.cn/o/example https://xhslink.com/a/example https://weixin.qq.com/sph/Example123 https://channels.weixin.qq.com/finder-preview/pages/sph?sphid=Example123 https://mp.weixin.qq.com/s/article https://example.com/sph/Example123");
  assert.deepEqual(inputs.map(input => input.platform), ["xiaohongshu", "xiaohongshu", "wechat_channels", "wechat_channels", "wechat", "web"]);
  assert.equal(inputs[2].nativeId, "sph:Example123");
});

test("reclassifies old web jobs and resolves xhslink.cn to the signed target note", async t => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  t.mock.method(globalThis, "fetch", async (url: string | URL) => String(url).includes("xhslink.cn")
    ? new Response(null, { status: 302, headers: { location: "https://www.xiaohongshu.com/explore/123456789012345678901234?xsec_token=placeholder" } })
    : new Response("note"));
  const resolved = await resolveContentInput({ url: "https://xhslink.cn/o/example", platform: "web", canonicalUrl: "https://xhslink.cn/o/example" });
  assert.equal(resolved.platform, "xiaohongshu");
  assert.equal(resolved.nativeId, "123456789012345678901234");
  assert.match(resolved.url, /xsec_token=placeholder/);
  assert.doesNotMatch(resolved.canonicalUrl, /placeholder/);
  const channels = await resolveContentInput({ url: "https://weixin.qq.com/sph/Example123", platform: "web", canonicalUrl: "https://weixin.qq.com/sph/Example123" });
  assert.equal(channels.platform, "wechat_channels");
});

test("a Xiaohongshu login redirect retains the note platform and original share URL", async t => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  t.mock.method(globalThis, "fetch", async (url: string | URL) => String(url).includes("xhslink.cn")
    ? new Response(null, { status: 302, headers: { location: "https://www.xiaohongshu.com/login" } })
    : new Response("login"));
  const source = "https://xhslink.cn/o/example";
  const resolved = await resolveContentInput(parseContentLinks(source)[0]);
  assert.equal(resolved.platform, "xiaohongshu");
  assert.equal(resolved.url, source);
});

test("recognizes only YouTube single-video URL shapes and canonicalizes aliases without tracking or playlist queries", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=abcdefghijk&list=private-list&index=5&si=tracking",
    "https://youtu.be/abcdefghijk?si=tracking&t=10",
    "https://m.youtube.com/shorts/abcdefghijk?feature=share",
    "https://www.youtube-nocookie.com/embed/abcdefghijk?autoplay=1",
    "https://music.youtube.com/watch?v=abcdefghijk",
  ]) {
    const input = parseContentLinks(url)[0];
    assert.equal(input.platform, "youtube"); assert.equal(input.nativeId, "abcdefghijk");
    assert.equal(input.canonicalUrl, "https://www.youtube.com/watch?v=abcdefghijk");
    assert.equal(input.url, url);
  }
});

test("deduplicates the same YouTube video across watch, short-share and embed URLs", () => {
  const inputs = parseContentLinks("https://youtube.com/watch?v=abcdefghijk https://youtu.be/abcdefghijk https://youtube.com/embed/abcdefghijk https://youtube.com/shorts/ABCDEFGHIJK");
  assert.equal(inputs.length, 2); assert.deepEqual(inputs.map(input => input.nativeId), ["abcdefghijk", "ABCDEFGHIJK"]);
});

test("YouTube playlists, channels, search, live links, invalid IDs and spoofed hosts remain ordinary webpages", () => {
  for (const url of [
    "https://www.youtube.com/playlist?list=PL-example", "https://www.youtube.com/@example", "https://www.youtube.com/results?search_query=example",
    "https://www.youtube.com/live/abcdefghijk", "https://www.youtube.com/watch?v=short", "https://youtu.be/abcdefghijk/extra",
    "https://www.youtube.com/watch?v=abcdefghijk&v=ABCDEFGHIJK", "https://youtube.com.evil.example/watch?v=abcdefghijk",
    "https://notyoutube.com/watch?v=abcdefghijk", "https://youtube.com:8443/watch?v=abcdefghijk",
  ]) assert.equal(parseContentLinks(url)[0].platform, "web", url);
});

test("resolving old web jobs recognizes an explicit YouTube ID without requesting the share page", async t => {
  let requests = 0; t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("no share-page request is needed"); });
  const input = await resolveContentInput({ platform: "web", url: "https://youtu.be/abcdefghijk?si=tracking", canonicalUrl: "https://youtu.be/abcdefghijk" });
  assert.equal(input.platform, "youtube"); assert.equal(input.nativeId, "abcdefghijk"); assert.equal(requests, 0);
});

test("a short link that redirects to a private address is still rejected before visiting it", async t => {
  let requests = 0; t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  t.mock.method(globalThis, "fetch", async () => { requests++; return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }); });
  await assert.rejects(resolveContentInput(parseContentLinks("https://b23.tv/example")[0]), /私网/); assert.equal(requests, 1);
});

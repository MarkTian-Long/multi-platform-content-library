import test from "node:test";
import assert from "node:assert/strict";
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

test("resolves a short link without moving a signed access URL into its canonical identity", async () => {
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

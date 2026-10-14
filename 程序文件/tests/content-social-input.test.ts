import test from "node:test";
import assert from "node:assert/strict";
import { promises as dns } from "node:dns";
import { parseContentLinks, resolveContentInput } from "../src/content-input.js";
import { douyinWorkReference, weiboPostReference, weiboMidToBid, weiboBidToMid } from "../src/content-social-reference.js";

test("Douyin single-work aliases share a numeric identity without access query parameters", () => {
  const id = "6961737553342991651";
  for (const url of [`https://www.douyin.com/video/${id}?from=share&token=secret`, `https://douyin.com/?modal_id=${id}`, `https://www.douyin.com/user/abc?modal_id=${id}`, `https://www.iesdouyin.com/share/video/${id}/`]) {
    const input = parseContentLinks(url)[0];
    assert.equal(input.platform, "douyin"); assert.equal(input.nativeId, id);
    assert.equal(input.canonicalUrl, `https://www.douyin.com/video/${id}`); assert.equal(input.url, url);
  }
  const note = douyinWorkReference(`https://www.douyin.com/note/${id}`);
  assert.equal(note?.kind, "note"); assert.equal(note?.nativeId, id);
  assert.equal(parseContentLinks(`https://douyin.com/video/${id} https://douyin.com/?modal_id=${id}`).length, 1);
});

test("Douyin shares preserve their own platform before resolution, without recognizing profiles or live pages as works", () => {
  assert.equal(parseContentLinks("复制 https://v.douyin.com/AbCd123/ 看视频")[0].platform, "douyin");
  for (const url of ["https://douyin.com/user/abc", "https://douyin.com/collection/123", "https://live.douyin.com/123", "https://douyin.com/video/short", "https://douyin.com/video/6961737553342991651/extra", "https://douyin.com/?modal_id=6961737553342991651&modal_id=6982497745948921092", "https://douyin.com/video/6961737553342991651?modal_id=6982497745948921092", "https://douyin.com.evil.example/video/6961737553342991651", "https://douyin.com:8443/video/6961737553342991651"])
    assert.equal(parseContentLinks(url)[0].platform, "web", url);
});

test("Douyin official slides shares identify the same gallery before any later verification redirect", async t => {
  const id = "7635876375336879226", canonicalUrl = `https://www.douyin.com/note/${id}`;
  for (const host of ["iesdouyin.com", "www.iesdouyin.com"]) {
    const url = `https://${host}/share/slides/${id}/?from=share`;
    assert.deepEqual(douyinWorkReference(url), { nativeId: id, canonicalUrl, kind: "note" });
    assert.equal(parseContentLinks(url)[0].platform, "douyin");
  }
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  t.mock.method(globalThis, "fetch", async (value: string | URL) => {
    const url = new URL(value);
    return url.hostname === "v.douyin.com" ? new Response(null, { status: 302, headers: { location: `https://www.iesdouyin.com/share/slides/${id}/` } })
      : url.pathname.startsWith("/share/slides/") ? new Response(null, { status: 302, headers: { location: "https://www.douyin.com/passport/login" } }) : new Response("verification");
  });
  const result = await resolveContentInput(parseContentLinks("https://v.douyin.com/ExampleGallery/")[0]);
  assert.equal(result.nativeId, id); assert.equal(result.canonicalUrl, canonicalUrl);
  for (const invalid of [`https://iesdouyin.com/share/slides/${id}/extra`, `https://iesdouyin.com.evil.example/share/slides/${id}`, "https://iesdouyin.com/share/slides/short"]) assert.equal(douyinWorkReference(invalid), undefined);
});

test("Weibo decimal MID and base62 BID are canonical aliases, with no floating point loss", () => {
  for (const [mid, bid] of [["4910815147462302", "N4xlMvjhI"], ["4189191225395228", "FBqgOmDxO"], ["4797700463137878", "LEZDodaiW"]]) {
    assert.equal(weiboMidToBid(mid), bid); assert.equal(weiboBidToMid(bid), mid);
    const inputs = parseContentLinks(`https://weibo.com/7827771738/${bid}?from=share https://m.weibo.cn/detail/${mid} https://m.weibo.cn/status/${mid} https://weibo.com/0/${mid}`);
    assert.equal(inputs.length, 1); assert.equal(inputs[0].platform, "weibo");
    assert.equal(inputs[0].nativeId, bid); assert.equal(inputs[0].canonicalUrl, `https://m.weibo.cn/status/${bid}`);
  }
  assert.equal(weiboMidToBid("0"), undefined); assert.equal(weiboMidToBid("0004910815147462302"), undefined);
  assert.equal(weiboBidToMid("../secret"), undefined);
});

test("Weibo TV references keep a video object identity distinct from post IDs", () => {
  const fid = "1034:4797699866951785";
  for (const url of [`https://weibo.com/tv/show/${fid}?from=share`, `https://video.weibo.com/show?fid=${fid}`, `https://www.weibo.com/tv/show/1034%3A4797699866951785`]) {
    const reference = weiboPostReference(url); assert.equal(reference?.nativeId, `video:${fid}`);
    assert.equal(reference?.canonicalUrl, `https://weibo.com/tv/show/${fid}`);
  }
  assert.equal(weiboPostReference("https://weibo.com/tv/show/1034:633c288cc043d0ca7808030f1157da64")?.kind, "video");
  for (const url of ["https://weibo.com/u/7827771738", "https://weibo.com/7827771738", "https://s.weibo.com/weibo/hello", "https://m.weibo.cn/status/N4xlMvjhI/extra", "https://weibo.com.evil.example/7827771738/N4xlMvjhI", "https://weibo.com:8443/7827771738/N4xlMvjhI", "https://video.weibo.com/show?fid=1034:4797699866951785&fid=1034:4797699866951786"])
    assert.equal(parseContentLinks(url)[0].platform, "web", url);
});

test("public Douyin and t.cn redirects identify only the resolved work/post and reject identity changes", async t => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  t.mock.method(globalThis, "fetch", async (url: string | URL) => String(url).includes("v.douyin.com")
    ? new Response(null, { status: 302, headers: { location: "https://www.iesdouyin.com/share/video/6961737553342991651/?token=secret" } })
    : String(url).includes("t.cn") ? new Response(null, { status: 302, headers: { location: "https://weibo.com/7827771738/N4xlMvjhI?from=share" } }) : new Response("ok"));
  const douyin = await resolveContentInput(parseContentLinks("https://v.douyin.com/AbCd123/")[0]);
  assert.equal(douyin.platform, "douyin"); assert.equal(douyin.nativeId, "6961737553342991651"); assert.doesNotMatch(douyin.canonicalUrl, /secret/);
  const weibo = await resolveContentInput(parseContentLinks("https://t.cn/A6aerGsM")[0]);
  assert.equal(weibo.platform, "weibo"); assert.equal(weibo.nativeId, "N4xlMvjhI");
});

test("Douyin verification redirects preserve the submitted share; unrelated redirects cannot become another platform", async t => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  let destination = "https://www.douyin.com/passport/login";
  t.mock.method(globalThis, "fetch", async (url: string | URL) => String(url).includes("v.douyin.com") ? new Response(null, { status: 302, headers: { location: destination } }) : new Response("ok"));
  const source = parseContentLinks("https://v.douyin.com/AbCd123/")[0];
  assert.deepEqual(await resolveContentInput(source), source);
  destination = "https://example.com/advertisement";
  await assert.rejects(resolveContentInput(source), /目标作品/);
  destination = "http://127.0.0.1/secret";
  await assert.rejects(resolveContentInput(source), /私网/);
});

test("social short links retain the exact target identity before a later login or verification redirect", async t => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  t.mock.method(globalThis, "fetch", async (value: string | URL) => {
    const url = new URL(value);
    const next = url.hostname === "t.cn" ? "https://m.weibo.cn/detail/4910815147462302" : url.hostname === "v.douyin.com" ? "https://www.iesdouyin.com/share/video/6961737553342991651/" : url.pathname.includes("/detail/") ? "https://visitor.passport.weibo.cn/visitor/visitor" : url.pathname.includes("/share/video/") ? "https://www.douyin.com/passport/login" : undefined;
    return next ? new Response(null, { status: 302, headers: { location: next } }) : new Response("verification page");
  });
  const weibo = await resolveContentInput(parseContentLinks("https://t.cn/A6aerGsM")[0]);
  assert.equal(weibo.platform, "weibo"); assert.equal(weibo.nativeId, "N4xlMvjhI"); assert.equal(weibo.url, "https://m.weibo.cn/detail/4910815147462302");
  const douyin = await resolveContentInput(parseContentLinks("https://v.douyin.com/AbCd123/")[0]);
  assert.equal(douyin.platform, "douyin"); assert.equal(douyin.nativeId, "6961737553342991651");
});

test("t.cn cannot save a platform visitor or login landing page as the original post", async t => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  t.mock.method(globalThis, "fetch", async (url: string | URL) => String(url).includes("t.cn") ? new Response(null, { status: 302, headers: { location: "https://visitor.passport.weibo.cn/visitor/visitor" } }) : new Response("login"));
  await assert.rejects(resolveContentInput(parseContentLinks("https://t.cn/A6aerGsM")[0]), /目标帖子/);
});

test("social short links reject redirects between different declared post or work IDs", async t => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  t.mock.method(globalThis, "fetch", async (value: string | URL) => {
    const url = new URL(value);
    const next = url.hostname === "t.cn" ? "https://m.weibo.cn/status/N4xlMvjhI" : url.pathname.endsWith("N4xlMvjhI") ? "https://m.weibo.cn/status/FBqgOmDxO" : undefined;
    return next ? new Response(null, { status: 302, headers: { location: next } }) : new Response("different post");
  });
  await assert.rejects(resolveContentInput(parseContentLinks("https://t.cn/A6aerGsM")[0]), /不同目标/);
});

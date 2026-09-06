import test from "node:test";
import assert from "node:assert/strict";
import { captureRenderedPage } from "../src/browser/capture-page.js";
import { runInNewContext } from "node:vm";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadArticleVideos } from "../src/article-videos.js";

test("waits for article content, extracts it, and closes the page", async () => {
  let closed = false;
  const page = { goto: async () => {}, waitForSelector: async () => {}, content: async () => "<h1 id='activity-name'>标题</h1><div id='js_content'><p>正文</p></div>", title: async () => "标题", close: async () => { closed = true; } };
  const result = await captureRenderedPage(page, "https://mp.weixin.qq.com/s/example", new Date("2026-09-03T00:00:00.000Z"));
  assert.equal(result.status, "complete");
  assert.match(result.sourceHtml ?? "", /js_content/);
  assert.equal(closed, true);
});

test("maps selector timeout to timeout and closes the page", async () => {
  let closed = false;
  const page = { goto: async () => {}, waitForSelector: async () => { throw new Error("Timeout 30000ms exceeded"); }, content: async () => "", title: async () => "", close: async () => { closed = true; } };
  const result = await captureRenderedPage(page, "https://mp.weixin.qq.com/s/example");
  assert.equal(result.status, "timeout");
  assert.equal(closed, true);
  assert.match(result.error ?? "", /等待文章正文.*超时/);
});

test("preserves a denied-navigation error without exposing URL query parameters", async () => {
  const page = { goto: async () => { throw new Error("page.goto: net::ERR_NETWORK_ACCESS_DENIED at https://mp.weixin.qq.com/s/a?key=private-token"); }, waitForSelector: async () => {}, content: async () => "", title: async () => "", close: async () => {} };
  const result = await captureRenderedPage(page, "https://mp.weixin.qq.com/s/a?key=private-token");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /网络访问被拒绝/);
  assert.match(result.error ?? "", /ERR_NETWORK_ACCESS_DENIED/);
  assert.doesNotMatch(result.error ?? "", /private-token/);
});

test("page-close failure cannot replace extracted content or the original navigation error", async () => {
  const page = { goto: async () => {}, waitForSelector: async () => {}, content: async () => "<h1 id='activity-name'>标题</h1><div id='js_content'>正文</div>", title: async () => "", close: async () => { throw new Error("close failed"); } };
  assert.equal((await captureRenderedPage(page, "https://mp.weixin.qq.com/s/a")).markdown, "正文");
  page.goto = async () => { throw new Error("net::ERR_CONNECTION_RESET"); };
  assert.match((await captureRenderedPage(page, "https://mp.weixin.qq.com/s/a")).error ?? "", /ERR_CONNECTION_RESET/);
});

test("waits for the player's normal URL replacement before extracting and closing the page", async (t) => {
  const calls: string[] = [];
  let ready = false;
  let readinessScript = "";
  const page = {
    goto: async () => { calls.push("goto"); },
    waitForSelector: async () => { calls.push("body"); },
    waitForFunction: async (script: string, arg?: unknown, options?: { timeout?: number }) => {
      calls.push("videos");
      readinessScript = script;
      assert.equal(arg, undefined);
      assert.equal(options?.timeout, 15000);
      ready = true;
    },
    content: async () => { calls.push("extract"); return `<h1 id="activity-name">视频正文</h1><div id="js_content"><p>正文</p><video src="https://mpvideo.qpic.cn/${ready ? "playable" : "rejected"}.mp4"></video></div>`; },
    title: async () => "视频正文", close: async () => { calls.push("close"); }
  };
  const article = await captureRenderedPage(page, "https://mp.weixin.qq.com/s/video");
  assert.deepEqual(calls, ["goto", "body", "videos", "extract", "close"]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reader-ready-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const videos = await downloadArticleVideos(article, directory, async url => url.includes("playable")
    ? new Response(new Uint8Array(4), { headers: { "content-type": "video/mp4" } })
    : new Response(null, { status: 403 }));
  assert.equal(videos[0].status, "saved");

  // Execute the actual browser predicate against controlled media state.
  const video = { tagName: "VIDEO", readyState: 0, src: "https://mpvideo.qpic.cn/a.mp4", currentSrc: "", error: { code: 4 } as { code: number } | null, parentElement: null };
  const evaluate = (nodes: unknown[]) => runInNewContext(readinessScript, { document: { querySelectorAll: () => nodes } });
  assert.equal(evaluate([]), true, "text-only pages must not be delayed");
  assert.equal(evaluate([video]), false, "a transient player error must allow its normal fallback to run");
  video.readyState = 1;
  assert.equal(evaluate([video]), false, "metadata alone must not hide an unresolved media error");
  video.error = null;
  assert.equal(evaluate([video]), true);
  assert.equal(evaluate([{ tagName: "MP-VIDEO", querySelector: () => null, parentElement: null }]), false, "uninitialized native players must be awaited");
});

test("media preparation timeout preserves the article and still closes the page", async () => {
  let waited = false;
  let closed = false;
  const page = { goto: async () => {}, waitForSelector: async () => {},
    waitForFunction: async () => { waited = true; throw new Error("Timeout 15000ms exceeded"); },
    content: async () => "<h1 id='activity-name'>标题</h1><div id='js_content'><p>正文保留</p></div>",
    title: async () => "", close: async () => { closed = true; } };
  const article = await captureRenderedPage(page, "https://mp.weixin.qq.com/s/video");
  assert.equal(waited, true);
  assert.equal(article.markdown, "正文保留");
  assert.equal(closed, true);
});

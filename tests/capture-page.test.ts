import test from "node:test";
import assert from "node:assert/strict";
import { captureRenderedPage } from "../src/browser/capture-page.js";

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
});

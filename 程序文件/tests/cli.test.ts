import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../src/cli.js";

test("CLI emits a local directory for a successful capture", async () => {
  const result = await runCli(["capture", "https://mp.weixin.qq.com/s/example"], {
    capture: async () => ({ status: "complete", articleId: "b758e4d800cb74b5fd3ce525", title: "测试文章" }),
    locate: async () => "D:/reader/文章库/2026-09-03_测试文章_b758e4d8"
  });
  assert.deepEqual(result, {
    ok: true, status: "complete", articleId: "b758e4d800cb74b5fd3ce525", title: "测试文章",
    directory: "D:/reader/文章库/2026-09-03_测试文章_b758e4d8", imageSummary: { total: 0, saved: 0, failed: 0 }, message: "文章与 PDF 已保存到本地"
  });
});

test("CLI rejects commands without a WeChat article link", async () => {
  const result = await runCli([]);
  assert.equal(result.ok, false);
  assert.equal(result.message, "用法：capture <微信公众号文章链接>、list [关键词]、regenerate-pdf <文章标识>");
});
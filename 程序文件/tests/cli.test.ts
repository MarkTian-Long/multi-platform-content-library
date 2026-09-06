import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../src/cli.js";

test("CLI emits a local directory for a successful capture", async () => {
  const result = await runCli(["capture", "https://mp.weixin.qq.com/s/example"], {
    capture: async () => ({ status: "complete", articleId: "b758e4d800cb74b5fd3ce525", title: "测试文章", pdf: { status: "saved", path: "测试文章.pdf" }, imageSummary: { total: 0, saved: 0, failed: 0 }, videoSummary: { total: 0, saved: 0, failed: 0 } }),
    locate: async () => "D:/reader/文章库/2026-09-03_测试文章_b758e4d8"
  });
  assert.deepEqual(result, {
    ok: true, status: "complete", articleId: "b758e4d800cb74b5fd3ce525", title: "测试文章",
    directory: "D:/reader/文章库/2026-09-03_测试文章_b758e4d8", pdf: { status: "saved", path: "测试文章.pdf" }, imageSummary: { total: 0, saved: 0, failed: 0 }, videoSummary: { total: 0, saved: 0, failed: 0 }, message: "文章与 PDF 已保存到本地"
  });
});

test("CLI does not claim PDF success without PDF evidence", async () => {
  const result = await runCli(["capture", "https://mp.weixin.qq.com/s/a"], { capture: async () => ({ status: "complete", articleId: "a".repeat(24) }), locate: async () => "D:/library/article" });
  assert.equal(result.ok, true);
  assert.equal(result.status, "partial");
  assert.match(result.message, /文章已保存.*PDF.*未/);
  assert.doesNotMatch(result.message, /文章与 PDF 已保存/);
});

test("CLI reports saved text together with PDF, image, and video failures", async () => {
  const result = await runCli(["capture", "https://mp.weixin.qq.com/s/a"], {
    capture: async () => ({ status: "complete", articleId: "a".repeat(24), pdf: { status: "failed", reason: "打印失败" }, imageSummary: { total: 3, saved: 2, failed: 1 }, videoSummary: { total: 2, saved: 1, failed: 1 } }), locate: async () => "D:/library/article"
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "partial");
  assert.match(result.message, /PDF 未生成.*打印失败/);
  assert.match(result.message, /图片.*2\/3.*1.*失败/);
  assert.match(result.message, /视频.*1\/2.*1.*未保存/);
});

test("CLI returns a diagnostic failure when a library operation throws", async () => {
  const result = await runCli(["capture", "https://mp.weixin.qq.com/s/a"], { capture: async () => ({ status: "complete", articleId: "a".repeat(24) }), locate: async () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); } });
  assert.equal(result.ok, false);
  assert.match(result.message, /权限|拒绝/);
  assert.match(result.message, /EACCES/);
});

test("partial capture still reports successfully saved image and video counts", async () => {
  const base = { status: "partial" as const, articleId: "a".repeat(24), pdf: { status: "saved" as const, path: "文章.pdf" }, imageSummary: { total: 4, saved: 4, failed: 0 }, videoSummary: { total: 8, saved: 0, failed: 8 } };
  const result = await runCli(["capture", "https://mp.weixin.qq.com/s/a"], { capture: async () => base, locate: async () => "D:/library/article" });
  assert.equal(result.status, "partial");
  assert.match(result.message, /图片已保存 4\/4/);
  assert.match(result.message, /视频已保存 0\/8/);
  const pdfFailure = await runCli(["capture", "https://mp.weixin.qq.com/s/a"], { capture: async () => ({ ...base, pdf: { status: "failed", reason: "打印失败" }, videoSummary: { total: 2, saved: 2, failed: 0 } }), locate: async () => "D:/library/article" });
  assert.match(pdfFailure.message, /图片已保存 4\/4/);
  assert.match(pdfFailure.message, /视频已保存 2\/2/);
});

test("CLI rejects commands without a WeChat article link", async () => {
  const result = await runCli([]);
  assert.equal(result.ok, false);
  assert.equal(result.message, "用法：capture <微信公众号文章链接>、list [关键词]、regenerate-pdf <文章标识>");
});

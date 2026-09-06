import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { readArticle, saveArticle, writeArticleManifest, type ArticleManifest } from "../src/article-library.js";
import { recordPdfAttempt } from "../src/article-pdf.js";
import { captureWechatArticle } from "../src/mcp/handlers.js";
import { runCli } from "../src/cli.js";
import { extractRenderedArticle } from "../src/extract-article.js";

test("PDF attempt metadata records initial failure and clears that error after success", () => {
  const manifest: ArticleManifest = { articleId: "a".repeat(24), title: "测试", sourceUrl: "https://mp.weixin.qq.com/s/a", status: "complete", extractedAt: "2026-09-06", contentHash: "hash" };
  recordPdfAttempt(manifest, { status: "failed", reason: "打印失败" });
  assert.deepEqual(manifest.pdf, { status: "failed", reason: "打印失败" });
  assert.equal(manifest.lastPdfError, "打印失败");
  recordPdfAttempt(manifest, { status: "saved", path: "测试.pdf" });
  assert.deepEqual(manifest.pdf, { status: "saved", path: "测试.pdf" });
  assert.equal("lastPdfError" in manifest, false);
});

test("failed capture and regeneration retain the saved PDF path while reporting the latest failure", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-pdf-status-"));
  const library = path.join(directory, "articles");
  const previousRuntime = process.env.WECHAT_ARTICLE_READER_ROOT;
  const previousLibrary = process.env.WECHAT_ARTICLE_LIBRARY_ROOT;
  process.env.WECHAT_ARTICLE_READER_ROOT = directory;
  process.env.WECHAT_ARTICLE_LIBRARY_ROOT = library;
  t.after(() => {
    if (previousRuntime === undefined) delete process.env.WECHAT_ARTICLE_READER_ROOT; else process.env.WECHAT_ARTICLE_READER_ROOT = previousRuntime;
    if (previousLibrary === undefined) delete process.env.WECHAT_ARTICLE_LIBRARY_ROOT; else process.env.WECHAT_ARTICLE_LIBRARY_ROOT = previousLibrary;
  });
  const html = '<h1 id="activity-name">测试</h1><div id="js_content">正文</div>';
  const record = extractRenderedArticle(html, "https://mp.weixin.qq.com/s/a");
  record.sourceHtml = html;
  const saved = await saveArticle(library, record);
  saved.manifest.pdf = { status: "saved", path: "测试.pdf" };
  await fs.writeFile(path.join(saved.directory, "测试.pdf"), "old PDF");
  await writeArticleManifest(saved.directory, saved.manifest);
  t.mock.method(chromium, "launch", async () => { throw new Error("renderer unavailable"); });
  t.mock.method(chromium, "launchPersistentContext", async () => ({
    newPage: async () => ({ goto: async () => {}, waitForSelector: async () => {}, content: async () => html, title: async () => "测试", close: async () => {} }), close: async () => {}
  }));
  const capture = await captureWechatArticle({ url: record.sourceUrl });
  assert.equal(capture.pdf?.status, "failed");
  assert.equal(capture.status, "partial");
  let stored = await readArticle(library, saved.articleId);
  assert.equal(stored.ok, true);
  if (!stored.ok) return;
  assert.deepEqual(stored.manifest.pdf, { status: "saved", path: "测试.pdf" });
  assert.match(stored.manifest.lastPdfError ?? "", /renderer unavailable/);
  const regeneration = await runCli(["regenerate-pdf", saved.articleId]);
  assert.equal(regeneration.ok, false);
  assert.equal(regeneration.pdf?.status, "failed");
  stored = await readArticle(library, saved.articleId);
  assert.equal(stored.ok && stored.manifest.pdf?.status, "saved");
  assert.equal(await fs.readFile(path.join(saved.directory, "测试.pdf"), "utf8"), "old PDF");
});

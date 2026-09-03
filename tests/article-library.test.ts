import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveArticle, findArticles, readArticle } from "../src/article-library.js";
import type { ArticleRecord } from "../src/article.js";

const record: ArticleRecord = { title: "测试标题", markdown: "正文内容", sourceUrl: "https://mp.weixin.qq.com/s/abc", extractedAt: "2026-09-03T00:00:00.000Z", status: "complete", sourceHtml: "<p>正文内容</p>" };

test("saves exactly the constrained article record files and searches metadata only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-reader-"));
  const saved = await saveArticle(root, record);
  assert.deepEqual((await fs.readdir(saved.directory)).sort(), ["article.md", "manifest.json", "source.html"]);
  assert.equal((await findArticles(root, "标题"))[0].title, "测试标题");
  assert.equal("markdown" in (await findArticles(root, "标题"))[0], false);
});

test("rejects traversal when reading an article", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-reader-"));
  const result = await readArticle(root, "../outside");
  assert.equal(result.ok, false);
});

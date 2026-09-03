import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { articleDirectoryName, saveArticle, findArticles, readArticle } from "../src/article-library.js";
import type { ArticleRecord } from "../src/article.js";

const record: ArticleRecord = { title: "测试标题", markdown: "正文内容", sourceUrl: "https://mp.weixin.qq.com/s/abc", extractedAt: "2026-09-03T00:00:00.000Z", status: "complete", sourceHtml: "<p>正文内容</p>" };

test("saves results in a readable folder and searches metadata only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-reader-"));
  const saved = await saveArticle(root, record);
  assert.equal(path.basename(saved.directory), "2026-09-03_测试标题");
  assert.deepEqual((await fs.readdir(saved.directory)).sort(), ["images", "manifest.json", "source.html", "测试标题.md"]);
  assert.equal((await findArticles(root, "标题"))[0].title, "测试标题");
  assert.equal("markdown" in (await findArticles(root, "标题"))[0], false);
});

test("adds a readable suffix only when different articles share a title and date", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-reader-"));
  await saveArticle(root, record);
  const next = await saveArticle(root, { ...record, markdown: "另一篇正文" });
  assert.equal(path.basename(next.directory), "2026-09-03_测试标题（2）");
  assert.match(next.manifest.articleId, /^[a-f0-9]{24}$/);
});

test("rejects traversal when reading an article", async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-reader-")); assert.equal((await readArticle(root, "../outside")).ok, false); });
test("creates a Windows-safe readable article directory", () => assert.equal(articleDirectoryName({ ...record, title: "<>:标题/测试?*" }), "2026-09-03_标题测试"));
test("downloads captured images locally and rewrites article markdown", async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-reader-")); const imageRecord: ArticleRecord = { ...record, markdown: "![示例图片](https://cdn.example.com/example.png)", images: [{ index: 1, sourceUrl: "https://cdn.example.com/example.png", alt: "示例图片" }] }; const saved = await saveArticle(root, imageRecord, { fetcher: async () => new Response(Uint8Array.of(137, 80, 78, 71), { headers: { "content-type": "image/png" } }) }); assert.equal((await fs.readFile(path.join(saved.directory, "测试标题.md"), "utf8")).includes("images/001.png"), true); assert.deepEqual([...await fs.readFile(path.join(saved.directory, "images", "001.png"))], [137, 80, 78, 71]); });
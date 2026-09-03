import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { extractRenderedArticle } from "../src/extract-article.js";

const fixtureHtml = fs.readFileSync(new URL("./fixtures/wechat-article.html", import.meta.url), "utf8");
const validUrl = "https://mp.weixin.qq.com/s/example";
const fixedTime = new Date("2026-09-03T00:00:00.000Z");

test("turns visible article content into safe Markdown", () => {
  const article = extractRenderedArticle(fixtureHtml, validUrl, fixedTime);
  assert.equal(article.status, "complete");
  assert.equal(article.title, "一篇真实标题");
  assert.match(article.markdown, /## 一个小标题/);
  assert.match(article.markdown, /\[参考\]\(https:\/\/example.com\/\)/);
  assert.equal(article.sourceUrl, validUrl);
  assert.equal(article.extractedAt, fixedTime.toISOString());
  assert.doesNotMatch(article.markdown, /window\.location|javascript:/);
  assert.deepEqual(article.images, [{ index: 1, sourceUrl: "https://example.com/image.png", alt: "示例图片" }]);
  assert.match(article.markdown, /!\[示例图片\]\(https:\/\/example\.com\/image\.png\)/);
});

test("marks empty content as empty without pretending there is a body", () => {
  const article = extractRenderedArticle("<h1 id='activity-name'>标题</h1><div id='js_content'></div>", validUrl, fixedTime);
  assert.equal(article.status, "empty");
  assert.equal(article.markdown, "");
});

test("marks missing title as partial while retaining non-empty content", () => {
  const article = extractRenderedArticle("<div id='js_content'><p>正文</p></div>", validUrl, fixedTime);
  assert.equal(article.status, "partial");
  assert.match(article.markdown, /正文/);
  assert.equal(article.title, "未命名文章");
});

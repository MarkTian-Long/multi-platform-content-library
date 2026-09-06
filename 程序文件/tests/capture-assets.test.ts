import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveArticle, findArticles } from "../src/article-library.js";
import { extractRenderedArticle } from "../src/extract-article.js";
import { buildPdfHtml } from "../src/article-pdf.js";

test("saves video files, repairs failed captures, and reuses saved files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-library-video-"));
  const html = '<h1 id="activity-name">视频文章</h1><div id="js_content"><p>正文</p><video src="https://mpvideo.qpic.cn/example.mp4?auth_key=private-token"></video></div>';
  const createRecord = () => { const article = extractRenderedArticle(html, "https://mp.weixin.qq.com/s/a", new Date("2026-09-03")); article.sourceHtml = html; return article; };
  const first = await saveArticle(root, createRecord(), { videoFetcher: async () => new Response("denied", { status: 403 }) });
  assert.equal(first.manifest.videos?.[0].status, "failed");
  const second = await saveArticle(root, createRecord(), { videoFetcher: async () => new Response(Uint8Array.of(1, 2, 3, 4), { headers: { "content-type": "video/mp4" } }) });
  assert.equal(second.directory, first.directory);
  assert.equal(second.manifest.videos?.[0].status, "saved");
  assert.match(await fs.readFile(path.join(second.directory, "视频文章.md"), "utf8"), /videos\/001\.mp4/);
  assert.doesNotMatch(await fs.readFile(path.join(second.directory, "source.html"), "utf8"), /private-token/);
  assert.doesNotMatch(await fs.readFile(path.join(second.directory, "manifest.json"), "utf8"), /private-token/);
  const third = await saveArticle(root, createRecord(), { videoFetcher: async () => { throw new Error("saved video must not download again"); } });
  assert.equal(third.manifest.videos?.[0].status, "saved");
  assert.deepEqual([...await fs.readFile(path.join(third.directory, "videos/001.mp4"))], [1, 2, 3, 4]);
});

test("re-reading retries failed images and list includes its directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-library-retry-"));
  const record = extractRenderedArticle('<h1 id="activity-name">图片文章</h1><div id="js_content"><img src="https://cdn.example.com/a.png"></div>', "https://mp.weixin.qq.com/s/a", new Date("2026-09-03"));
  await saveArticle(root, record, { fetcher: async () => new Response("failed", { status: 500 }) });
  const saved = await saveArticle(root, record, { fetcher: async () => new Response(Uint8Array.of(1), { headers: { "content-type": "image/png" } }) });
  assert.equal(saved.manifest.images?.[0].status, "saved");
  assert.equal((await findArticles(root, ""))[0].directory, saved.directory);
});

test("PDF uses inert video placeholders and drops remote executable content", () => {
  const manifest = { articleId: "a".repeat(24), title: '<script>unsafe</script>', sourceUrl: "https://mp.weixin.qq.com/s/a", status: "complete" as const, extractedAt: "2026-09-03", contentHash: "hash", videos: [{ index: 1, label: "视频 1", provider: "wechat" as const, sourceArticleUrl: "https://mp.weixin.qq.com/s/a", status: "saved" as const, localPath: "videos/001.mp4" }] };
  const html = buildPdfHtml('<div id="js_content"><script>alert(1)</script><iframe src="https://evil.example"></iframe><p onclick="alert(1)" style="background:url(https://evil.example)">正文</p><p data-article-video-index="1">视频</p><img src="https://evil.example/a.png"></div>', manifest, "D:/library/article");
  assert.doesNotMatch(html, /<script|<iframe|onclick=|evil\.example/);
  assert.match(html, /videos\/001\.mp4/);
  assert.match(html, /PDF.*不.*播放/);
  assert.match(html, /&lt;script&gt;unsafe/);
});

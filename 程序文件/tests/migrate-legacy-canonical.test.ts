import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrateLegacyLibrary } from "../src/migrate-legacy-library.js";
import { listManifests, saveContent, contentDirectory, findContent } from "../src/content-library.js";
import { parseContentLinks } from "../src/content-input.js";
import { renderArticleMarkdown } from "../src/markdown.js";
import type { ArticleManifest } from "../src/article-library.js";
import { withContentMaintenance } from "../src/content-jobs.js";

async function fixture(t: any, version = 3) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "canonical-legacy-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const runtime = path.join(project, "程序文件"), root = path.join(project, "资料库");
  const source = path.join(runtime, "article-library", "01-original");
  await fs.mkdir(source, { recursive: true }); await fs.mkdir(root);
  await fs.writeFile(path.join(root, ".library-layout.json"), JSON.stringify({ version }));
  const previous = process.env.WECHAT_ARTICLE_LIBRARY_ROOT;
  process.env.WECHAT_ARTICLE_LIBRARY_ROOT = path.join(project, "文章库");
  t.after(() => { if (previous === undefined) delete process.env.WECHAT_ARTICLE_LIBRARY_ROOT; else process.env.WECHAT_ARTICLE_LIBRARY_ROOT = previous; });
  const article: ArticleManifest = {
    articleId: "a".repeat(24), title: "旧资料的完整文章", sourceUrl: "https://mp.weixin.qq.com/s/migration-local",
    status: "complete", extractedAt: "2026-09-03T00:00:00.000Z", contentHash: "legacy-content-hash", markdownFile: "旧正文.md", htmlFile: "source.html",
    images: [{ index: 1, sourceUrl: "https://cdn.example.com/one.png", alt: "第一张", status: "saved", localPath: "images/001.png" }],
    videos: [{ index: 1, label: "视频 1", status: "saved", localPath: "videos/001.mp4", provider: "wechat", sourceArticleUrl: "https://mp.weixin.qq.com/s/migration-local" }],
    pdf: { status: "saved", path: "旧阅读.pdf" }
  };
  const body = "旧文章全文保存在本地。\n\n![第一张](images/001.png)";
  await fs.writeFile(path.join(source, article.markdownFile!), renderArticleMarkdown({ ...article, markdown: body }));
  await fs.writeFile(path.join(source, "article.md"), renderArticleMarkdown({ ...article, markdown: body }));
  await fs.writeFile(path.join(source, "manifest.json"), JSON.stringify(article));
  await fs.writeFile(path.join(source, "source.html"), '<div id="js_content"><p>旧文章原文排版</p><img data-src="https://cdn.example.com/one.png"></div>');
  await fs.mkdir(path.join(source, "images")); await fs.writeFile(path.join(source, "images/001.png"), "original-image-bytes");
  await fs.mkdir(path.join(source, "videos")); await fs.writeFile(path.join(source, "videos/001.mp4"), "original-video-bytes");
  await fs.writeFile(path.join(source, "旧阅读.pdf"), "%PDF-original-local");
  await fs.writeFile(path.join(source, "未知保留.txt"), "unknown original remains here");
  return { project, runtime, root, source, article, body };
}

for (const version of [2, 3]) test(`initialized layout ${version} imports local legacy files into the canonical library without another article folder`, async t => {
  const f = await fixture(t, version), originals = new Map<string, Buffer>();
  for (const name of [f.article.markdownFile!, "article.md", "manifest.json", "source.html", "images/001.png", "videos/001.mp4", "旧阅读.pdf", "未知保留.txt"]) originals.set(name, await fs.readFile(path.join(f.source, name)));
  t.mock.method(globalThis, "fetch", async () => { throw new Error("migration must not access the network"); });
  assert.deepEqual(await migrateLegacyLibrary(f.runtime), { migrated: 1, skipped: 0, errors: 0 });
  const entries = await listManifests(f.root); assert.equal(entries.length, 1);
  const { directory, manifest } = entries[0]; assert.equal(manifest.storageVersion, version);
  assert.equal(manifest.coverage?.legacyArticleId, f.article.articleId);
  const copied = (id: string) => path.join(directory, manifest.assets.find(asset => asset.id === id)!.path!);
  assert.deepEqual(await fs.readFile(copied("wechat-source-html")), originals.get("source.html"));
  assert.deepEqual(await fs.readFile(copied("wechat-source-markdown")), originals.get(f.article.markdownFile!));
  assert.deepEqual(await fs.readFile(copied("wechat-source-manifest")), originals.get("manifest.json"));
  assert.deepEqual(await fs.readFile(copied("image-1")), originals.get("images/001.png"));
  assert.deepEqual(await fs.readFile(copied("video-1")), originals.get("videos/001.mp4"));
  assert.equal(await fs.readFile((await findContent(f.root))[0].pdfPath!, "utf8"), "%PDF-original-local");
  const compatibility = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
  assert.equal(compatibility.contentId, manifest.contentId); assert.equal(compatibility.articleId, f.article.articleId);
  assert.ok(compatibility.articleIds.includes(f.article.articleId)); assert.equal(compatibility.markdownFile, manifest.markdownFile);
  assert.match(await fs.readFile(path.join(directory, manifest.readingFile), "utf8"), /旧文章原文排版/);
  assert.equal(await fs.lstat(path.join(f.runtime, "文章库")).then(() => true, () => false), false);
  assert.equal(await fs.lstat(path.join(f.project, "文章库")).then(() => true, () => false), false);
  const before = await fs.readFile(path.join(directory, "content.json"));
  assert.deepEqual(await migrateLegacyLibrary(f.runtime), { migrated: 0, skipped: 1, errors: 0 });
  assert.deepEqual(await fs.readFile(path.join(directory, "content.json")), before);
  for (const [name, bytes] of originals) assert.deepEqual(await fs.readFile(path.join(f.source, name)), bytes);
});

test("a second legacy ID for existing canonical content only adds an alias and preserves the newer full text and corrections", async t => {
  const f = await fixture(t), stage = path.join(f.project, "newer-stage"); await fs.mkdir(stage);
  await fs.writeFile(path.join(stage, "correction.md"), "校订后的文字");
  const input = parseContentLinks(f.article.sourceUrl)[0];
  const saved = await saveContent(f.root, { platform: "wechat", kind: "article", nativeId: input.nativeId, canonicalUrl: input.canonicalUrl, sourceUrl: f.article.sourceUrl, title: "较新的正式文章", capturedAt: "2026-10-21T00:00:00Z", markdown: "最新正式全文", warnings: [], assets: [{ id: "corrected", role: "transcript", status: "saved", path: "correction.md", provenance: "user_edited" }] }, stage);
  const directory = await contentDirectory(f.root, saved.contentId), currentId = "b".repeat(24);
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ ...f.article, articleId: currentId, articleIds: [currentId], contentId: saved.contentId, markdownFile: saved.markdownFile, title: saved.title }));
  const before = await fs.readFile(path.join(directory, "content.json")), body = await fs.readFile(path.join(directory, saved.markdownFile));
  const priorArticle = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
  const correction = path.join(directory, saved.assets.find(asset => asset.id === "corrected")!.path!), correctionBytes = await fs.readFile(correction);
  assert.deepEqual(await migrateLegacyLibrary(f.runtime), { migrated: 1, skipped: 0, errors: 0 });
  assert.equal((await listManifests(f.root)).length, 1);
  assert.deepEqual(await fs.readFile(path.join(directory, "content.json")), before);
  assert.deepEqual(await fs.readFile(path.join(directory, saved.markdownFile)), body);
  assert.deepEqual(await fs.readFile(correction), correctionBytes);
  const compatibility = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
  assert.equal(compatibility.articleId, currentId); assert.deepEqual(new Set(compatibility.articleIds), new Set([currentId, f.article.articleId]));
  assert.deepEqual({ ...compatibility, articleIds: priorArticle.articleIds }, priorArticle);
  assert.deepEqual(await migrateLegacyLibrary(f.runtime), { migrated: 0, skipped: 1, errors: 0 });
});

test("unknown or unsafe legacy records remain untouched and cannot publish outside files", async t => {
  const f = await fixture(t), outside = path.join(f.runtime, "article-library", "outside.md");
  await fs.writeFile(outside, "outside content must not be imported");
  f.article.markdownFile = "../outside.md";
  await fs.writeFile(path.join(f.source, "manifest.json"), JSON.stringify(f.article));
  const unknown = path.join(f.runtime, "article-library", "unknown"); await fs.mkdir(unknown); await fs.writeFile(path.join(unknown, "original.bin"), "unknown original");
  assert.deepEqual(await migrateLegacyLibrary(f.runtime), { migrated: 0, skipped: 0, errors: 2 });
  assert.equal((await listManifests(f.root)).length, 0);
  assert.equal(await fs.readFile(outside, "utf8"), "outside content must not be imported");
  assert.equal(await fs.readFile(path.join(unknown, "original.bin"), "utf8"), "unknown original");
  assert.equal(await fs.lstat(path.join(f.runtime, "文章库")).then(() => true, () => false), false);
});

test("legacy file junctions are rejected before canonical publication", async t => {
  const f = await fixture(t), outside = path.join(f.project, "outside"); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "001.png"), "must remain outside");
  await fs.rename(path.join(f.source, "images"), path.join(f.source, "retained-images"));
  await fs.symlink(outside, path.join(f.source, "images"), process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(await migrateLegacyLibrary(f.runtime), { migrated: 0, skipped: 0, errors: 1 });
  assert.equal((await listManifests(f.root)).length, 0);
  assert.equal(await fs.readFile(path.join(outside, "001.png"), "utf8"), "must remain outside");
});

test("an active canonical worker defers legacy import until the shared maintenance lock is available", async t => {
  const f = await fixture(t);
  await withContentMaintenance(f.root, async () => {
    assert.deepEqual(await migrateLegacyLibrary(f.runtime), { migrated: 0, skipped: 0, errors: 0 });
    assert.equal((await listManifests(f.root)).length, 0);
    assert.equal(await fs.readFile(path.join(f.source, "未知保留.txt"), "utf8"), "unknown original remains here");
  });
  assert.deepEqual(await migrateLegacyLibrary(f.runtime), { migrated: 1, skipped: 0, errors: 0 });
  assert.equal((await listManifests(f.root)).length, 1);
  assert.equal(await fs.lstat(path.join(f.runtime, "文章库")).then(() => true, () => false), false);
});

test("coverage metadata alone does not skip recovery of a missing legacy-ID compatibility manifest", async t => {
  const f = await fixture(t), input = parseContentLinks(f.article.sourceUrl)[0];
  const saved = await saveContent(f.root, { platform: "wechat", kind: "article", nativeId: input.nativeId, canonicalUrl: input.canonicalUrl, sourceUrl: f.article.sourceUrl, title: "当前正文", capturedAt: "2026-10-21T00:00:00Z", markdown: "当前完整正文不能回退", warnings: [], assets: [], coverage: { legacyArticleId: f.article.articleId } }, f.source);
  const directory = await contentDirectory(f.root, saved.contentId), before = await fs.readFile(path.join(directory, "content.json"));
  assert.deepEqual(await migrateLegacyLibrary(f.runtime), { migrated: 1, skipped: 0, errors: 0 });
  assert.deepEqual(await fs.readFile(path.join(directory, "content.json")), before);
  const compatibility = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
  assert.equal(compatibility.contentId, saved.contentId); assert.ok(compatibility.articleIds.includes(f.article.articleId));
  assert.equal(await fs.readFile(path.join(directory, saved.markdownFile), "utf8"), "当前完整正文不能回退");
  assert.deepEqual(await migrateLegacyLibrary(f.runtime), { migrated: 0, skipped: 1, errors: 0 });
});

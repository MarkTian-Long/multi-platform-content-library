import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { saveContent, contentDirectory, listManifests } from "../src/content-library.js";
import { saveArticle, readArticle } from "../src/article-library.js";
import type { CapturedContent } from "../src/content-types.js";
import type { ArticleRecord } from "../src/article.js";

async function fixture(t: any) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "new-install-library-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const root = path.join(project, "资料库"), stage = path.join(project, "input-stage"); await fs.mkdir(stage);
  await fs.writeFile(path.join(stage, "selected.txt"), "本机选择的原始文字文件");
  const record: CapturedContent = { platform: "web", kind: "article", title: "先保存的网页", sourceUrl: "https://example.com/first", canonicalUrl: "https://example.com/first", capturedAt: "2026-10-21T00:00:00Z", markdown: "通用保存入口的完整正文", assets: [], warnings: [] };
  const article: ArticleRecord = { title: "随后保存的公众号", sourceUrl: "https://mp.weixin.qq.com/s/new-install", extractedAt: "2026-10-21T00:00:00Z", status: "complete", markdown: "公众号完整正文", sourceHtml: '<div id="js_content"><p>公众号完整正文</p></div>' };
  return { project, root, stage, record, article };
}

for (const platform of ["web", "local"] as const) test(`a fresh default library first written by ${platform} keeps later WeChat APIs in the same version-3 items`, async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("this save must use local test inputs only"); });
  const sha = createHash("sha256").update(await fs.readFile(path.join(f.stage, "selected.txt"))).digest("hex"), localUrl = `local://sha256/txt/${sha}`;
  const first = await saveContent(f.root, platform === "web" ? f.record : { ...f.record, platform: "local", nativeId: `txt:${sha}`, canonicalUrl: localUrl, sourceUrl: localUrl, title: "先导入的本机文件", assets: [{ id: "selected-file", role: "source", status: "saved", path: "selected.txt", provenance: "original" }] }, f.stage);
  const saved = await saveArticle(f.root, f.article), legacyPath = path.join(f.project, "文章库");
  const throughOldPath = await saveArticle(legacyPath, { ...f.article, title: "旧接口也进入同一个库", sourceUrl: "https://mp.weixin.qq.com/s/new-install-legacy-path" });
  assert.equal(path.dirname(saved.directory), path.join(f.root, "items"));
  assert.equal(path.dirname(throughOldPath.directory), path.join(f.root, "items"));
  assert.equal(first.storageVersion, 3);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root, ".library-layout.json"), "utf8")), { version: 3 });
  assert.equal((await listManifests(f.root)).length, 3);
  assert.equal((await readArticle(f.root, saved.articleId)).ok, true);
  assert.equal((await readArticle(legacyPath, saved.articleId)).ok, true);
  assert.equal((await readArticle(f.root, throughOldPath.articleId)).ok, true);
  assert.equal(await fs.lstat(legacyPath).then(() => true, () => false), false);
  assert.ok((await fs.readdir(f.root, { withFileTypes: true })).filter(entry => entry.isDirectory()).every(entry => ["items", "staging"].includes(entry.name)));
  assert.equal(path.basename(await contentDirectory(f.root, first.contentId)).startsWith("2026-10-21_"), true);
  if (platform === "local") assert.equal(await fs.readFile(path.join(f.stage, "selected.txt"), "utf8"), "本机选择的原始文字文件");
});

test("a fresh default library first written by WeChat also shares version 3 with later generic content", async t => {
  const f = await fixture(t), article = await saveArticle(f.root, f.article);
  assert.equal(path.dirname(article.directory), path.join(f.root, "items"));
  const first = JSON.parse(await fs.readFile(path.join(article.directory, "content.json"), "utf8")); assert.equal(first.storageVersion, 3);
  assert.equal((await saveContent(f.root, f.record, f.stage)).storageVersion, 3);
  assert.equal((await listManifests(f.root)).length, 2);
  assert.equal((await readArticle(path.join(f.project, "文章库"), article.articleId)).ok, true);
});

test("known queue and staging infrastructure may precede the first default-library content write", async t => {
  const f = await fixture(t); await fs.mkdir(f.root);
  for (const directory of ["items", "staging", "exports", ".organization"]) await fs.mkdir(path.join(f.root, directory));
  const queue = '{"version":1,"jobs":[]}'; await fs.writeFile(path.join(f.root, "queue.json"), queue);
  await fs.writeFile(path.join(f.root, "worker.lock"), '{"pid":1234}');
  await fs.writeFile(path.join(f.root, "staging", "unfinished-original.bin"), "recovery original");
  const saved = await saveContent(f.root, f.record, f.stage); assert.equal(saved.storageVersion, 3);
  assert.equal(await fs.readFile(path.join(f.root, "queue.json"), "utf8"), queue);
  assert.equal(await fs.readFile(path.join(f.root, "staging", "unfinished-original.bin"), "utf8"), "recovery original");
});

test("existing supported layout markers keep their version and exact bytes on both write APIs", async t => {
  const f = await fixture(t);
  for (const version of [2, 3]) {
    const root = path.join(f.project, `version-${version}`, "资料库"); await fs.mkdir(root, { recursive: true });
    const marker = `{ "version": ${version}, "retained": "user metadata" }\n`; await fs.writeFile(path.join(root, ".library-layout.json"), marker);
    assert.equal((await saveContent(root, f.record, f.stage)).storageVersion, version);
    assert.equal(path.dirname((await saveArticle(root, f.article)).directory), path.join(root, "items"));
    assert.equal(await fs.readFile(path.join(root, ".library-layout.json"), "utf8"), marker);
  }
});

test("a custom library and an existing unmarked default-name library keep their prior storage contract", async t => {
  const f = await fixture(t), custom = path.join(f.project, "custom-library");
  const first = await saveContent(custom, f.record, f.stage); assert.equal(first.storageVersion, undefined);
  await fs.rename(custom, f.root);
  const next = await saveContent(f.root, { ...f.record, canonicalUrl: "https://example.com/second", sourceUrl: "https://example.com/second" }, f.stage);
  assert.equal(next.storageVersion, undefined);
  assert.equal(await fs.lstat(path.join(f.root, ".library-layout.json")).then(() => true, () => false), false);
  assert.equal(JSON.parse(await fs.readFile(path.join(await contentDirectory(f.root, first.contentId), "content.json"), "utf8")).storageVersion, undefined);
  assert.equal(path.dirname((await saveArticle(f.root, f.article)).directory), f.root);
});

test("unknown default-root files and an unmapped sibling article library prevent automatic adoption", async t => {
  const f = await fixture(t); await fs.mkdir(f.root); await fs.writeFile(path.join(f.root, "unknown-original.bin"), "retain unknown data");
  assert.equal((await saveContent(f.root, f.record, f.stage)).storageVersion, undefined);
  assert.equal(await fs.lstat(path.join(f.root, ".library-layout.json")).then(() => true, () => false), false);
  assert.equal(await fs.readFile(path.join(f.root, "unknown-original.bin"), "utf8"), "retain unknown data");
  const oldProject = path.join(f.project, "older-project"), oldLibrary = path.join(oldProject, "文章库"), freshRoot = path.join(oldProject, "资料库");
  await fs.mkdir(oldLibrary, { recursive: true }); await fs.writeFile(path.join(oldLibrary, "unknown-old-record.bin"), "existing article original");
  assert.equal((await saveContent(freshRoot, f.record, f.stage)).storageVersion, undefined);
  assert.equal(await fs.lstat(path.join(freshRoot, ".library-layout.json")).then(() => true, () => false), false);
  assert.equal(await fs.readFile(path.join(oldLibrary, "unknown-old-record.bin"), "utf8"), "existing article original");
});

test("malformed or unsupported layout markers reject a write without creating items or replacing the marker", async t => {
  const f = await fixture(t); await fs.mkdir(f.root);
  for (const marker of ['{"version":1}', '{"version":"3"}', "null", "[]", "{broken", "x".repeat(4097)]) {
    await fs.writeFile(path.join(f.root, ".library-layout.json"), marker);
    await assert.rejects(saveContent(f.root, f.record, f.stage), /布局|标记/);
    assert.equal(await fs.readFile(path.join(f.root, ".library-layout.json"), "utf8"), marker);
    assert.equal(await fs.lstat(path.join(f.root, "items")).then(() => true, () => false), false);
  }
  await fs.unlink(path.join(f.root, ".library-layout.json")); await fs.mkdir(path.join(f.root, ".library-layout.json"));
  await assert.rejects(saveContent(f.root, f.record, f.stage), /布局|标记/);
  assert.equal(await fs.lstat(path.join(f.root, "items")).then(() => true, () => false), false);
});

test("allowed infrastructure names with the wrong type do not count as a fresh initialized library", async t => {
  const f = await fixture(t); await fs.mkdir(f.root); await fs.writeFile(path.join(f.root, "staging"), "this is an original file, not a staging directory");
  assert.equal((await saveContent(f.root, f.record, f.stage)).storageVersion, undefined);
  assert.equal(await fs.lstat(path.join(f.root, ".library-layout.json")).then(() => true, () => false), false);
  assert.equal(await fs.readFile(path.join(f.root, "staging"), "utf8"), "this is an original file, not a staging directory");
});

test("a junction at a fresh root, its ancestor, items or staging cannot initialize a library or write through the target", async t => {
  const f = await fixture(t), outside = path.join(f.project, "outside"); await fs.mkdir(outside);
  const type = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(outside, f.root, type);
  await assert.rejects(saveContent(f.root, f.record, f.stage), /符号链接|目录/);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(f.root);
  for (const name of ["items", "staging"]) {
    const root = path.join(f.project, `linked-${name}`, "资料库"); await fs.mkdir(root, { recursive: true }); await fs.symlink(outside, path.join(root, name), type);
    await assert.rejects(saveContent(root, f.record, f.stage), /符号链接|目录/);
    assert.equal(await fs.lstat(path.join(root, ".library-layout.json")).then(() => true, () => false), false);
    assert.deepEqual(await fs.readdir(outside), []);
  }
  const linkedParent = path.join(f.project, "linked-parent"); await fs.symlink(outside, linkedParent, type);
  await assert.rejects(saveContent(path.join(linkedParent, "资料库"), f.record, f.stage), /符号链接|目录/);
  assert.deepEqual(await fs.readdir(outside), []);
});

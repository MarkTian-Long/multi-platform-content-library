import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveUnifiedArticleRoot } from "../src/article-root.js";

async function fixture(t: any, version = 3) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "article-root-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const root = path.join(project, "资料库"), legacy = path.join(project, "文章库");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, ".library-layout.json"), JSON.stringify({ version }));
  return { project, root, legacy };
}

test("canonical version 2 and 3 library roots resolve directly without creating anything", async t => {
  for (const version of [2, 3]) {
    const f = await fixture(t, version), before = await fs.readdir(f.project, { recursive: true });
    assert.equal(await resolveUnifiedArticleRoot(f.root), f.root);
    assert.deepEqual(await fs.readdir(f.project, { recursive: true }), before);
  }
});

test("the sibling canonical marker keeps an archived legacy path working without recreating it", async t => {
  const f = await fixture(t), before = await fs.readdir(f.project, { recursive: true });
  assert.equal(await resolveUnifiedArticleRoot(f.legacy), f.root);
  assert.deepEqual(await fs.readdir(f.project, { recursive: true }), before);
  assert.equal(await fs.lstat(f.legacy).then(() => true, () => false), false);
});

test("an existing same-project legacy directory also maps using the sibling layout", async t => {
  const f = await fixture(t); await fs.mkdir(f.legacy);
  assert.equal(await resolveUnifiedArticleRoot(f.legacy), f.root);
  assert.deepEqual(await fs.readdir(f.legacy), []);
});

test("an explicit old mapping only resolves a sibling with a supported canonical layout", async t => {
  const f = await fixture(t, 2); await fs.mkdir(f.legacy);
  await fs.writeFile(path.join(f.legacy, ".unified-library.json"), JSON.stringify({ version: 1, contentRoot: "../资料库" }));
  assert.equal(await resolveUnifiedArticleRoot(f.legacy), f.root);
  await fs.unlink(path.join(f.root, ".library-layout.json"));
  await assert.rejects(resolveUnifiedArticleRoot(f.legacy), /布局|正式资料库/);
  await fs.rmdir(f.root);
  await assert.rejects(resolveUnifiedArticleRoot(f.legacy), /布局|正式资料库/);
  assert.equal(await fs.lstat(f.root).then(() => true, () => false), false);
});

test("ordinary custom legacy libraries keep the legacy fallback", async t => {
  const f = await fixture(t), custom = path.join(f.project, "my-articles"); await fs.mkdir(custom);
  await fs.writeFile(path.join(custom, "retained.md"), "custom original");
  assert.equal(await resolveUnifiedArticleRoot(custom), undefined);
  const outside = path.join(f.project, "outside", "文章库"); await fs.mkdir(outside, { recursive: true });
  assert.equal(await resolveUnifiedArticleRoot(outside), undefined);
  assert.equal(await fs.readFile(path.join(custom, "retained.md"), "utf8"), "custom original");
});

test("a bare canonical-looking name is not treated as initialized storage", async t => {
  const f = await fixture(t); await fs.unlink(path.join(f.root, ".library-layout.json"));
  assert.equal(await resolveUnifiedArticleRoot(f.root), undefined);
  assert.equal(await resolveUnifiedArticleRoot(f.legacy), undefined);
});

test("unsupported, malformed and non-file canonical markers fail closed", async t => {
  const f = await fixture(t), marker = path.join(f.root, ".library-layout.json");
  for (const value of ['{"version":1}', '{"version":"3"}', "null", "[]", "not-json", "x".repeat(4097)]) {
    await fs.writeFile(marker, value);
    await assert.rejects(resolveUnifiedArticleRoot(f.root), /布局|标记/);
    await assert.rejects(resolveUnifiedArticleRoot(f.legacy), /布局|标记/);
  }
  await fs.unlink(marker); await fs.mkdir(marker);
  await assert.rejects(resolveUnifiedArticleRoot(f.root), /布局|标记/);
});

test("a legacy marker cannot redirect elsewhere or bypass a malformed local mapping", async t => {
  const f = await fixture(t); await fs.mkdir(f.legacy);
  const marker = path.join(f.legacy, ".unified-library.json");
  for (const value of [{ version: 1, contentRoot: "../../other" }, { version: 2, contentRoot: "../资料库" }, null, []]) {
    await fs.writeFile(marker, JSON.stringify(value));
    await assert.rejects(resolveUnifiedArticleRoot(f.legacy), /映射/);
  }
  await fs.writeFile(marker, "{broken"); await assert.rejects(resolveUnifiedArticleRoot(f.legacy), /映射/);
  await fs.writeFile(marker, "x".repeat(4097)); await assert.rejects(resolveUnifiedArticleRoot(f.legacy), /映射/);
});

test("a malformed direct-root mapping is not ignored when a canonical marker exists", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, ".unified-library.json"), JSON.stringify({ version: 1, contentRoot: "../../other" }));
  await assert.rejects(resolveUnifiedArticleRoot(f.root), /映射/);
});

test("conflicting canonical and legacy markers cannot select different storage roots", async t => {
  const f = await fixture(t); await fs.mkdir(f.legacy);
  await fs.writeFile(path.join(f.legacy, ".library-layout.json"), '{"version":3}');
  await fs.writeFile(path.join(f.legacy, ".unified-library.json"), '{"version":1,"contentRoot":"../资料库"}');
  await assert.rejects(resolveUnifiedArticleRoot(f.legacy), /冲突|映射/);
});

test("directory junctions at the root, sibling target or an ancestor are rejected", async t => {
  const f = await fixture(t), junctionType = process.platform === "win32" ? "junction" : "dir";
  const rootLink = path.join(f.project, "linked-library"); await fs.symlink(f.root, rootLink, junctionType);
  await assert.rejects(resolveUnifiedArticleRoot(rootLink), /符号链接|目录/);
  const parentLink = path.join(f.project, "linked-project"); await fs.symlink(f.project, parentLink, junctionType);
  await assert.rejects(resolveUnifiedArticleRoot(path.join(parentLink, "文章库")), /符号链接|目录/);
  const targetProject = path.join(f.project, "another-project"); await fs.mkdir(targetProject);
  await fs.symlink(f.root, path.join(targetProject, "资料库"), junctionType);
  await assert.rejects(resolveUnifiedArticleRoot(path.join(targetProject, "文章库")), /符号链接|目录/);
});

test("a symlinked marker cannot borrow a valid marker from elsewhere", async t => {
  const f = await fixture(t), marker = path.join(f.root, ".library-layout.json"), outside = path.join(f.project, "outside.json");
  await fs.writeFile(outside, '{"version":3}'); await fs.unlink(marker);
  try { await fs.symlink(outside, marker, "file"); }
  catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    t.skip("This Windows session cannot create file symlinks; directory junction boundaries are tested separately."); return;
  }
  await assert.rejects(resolveUnifiedArticleRoot(f.root), /布局|标记/);
});

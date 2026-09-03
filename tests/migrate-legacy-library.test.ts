import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrateLegacyLibrary } from "../src/migrate-legacy-library.js";

test("copies valid legacy records into readable Chinese article folders without deleting the source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-migration-"));
  const legacy = path.join(root, "article-library", "b758e4d800cb74b5fd3ce525");
  await fs.mkdir(legacy, { recursive: true });
  await fs.writeFile(path.join(legacy, "article.md"), "# 旧文章\n", "utf8");
  await fs.writeFile(path.join(legacy, "manifest.json"), JSON.stringify({
    articleId: "b758e4d800cb74b5fd3ce525", title: "旧文章：可读目录", sourceUrl: "https://mp.weixin.qq.com/s/example", status: "complete", extractedAt: "2026-09-03T00:00:00.000Z", contentHash: "abc"
  }), "utf8");
  assert.deepEqual(await migrateLegacyLibrary(root), { migrated: 1, skipped: 0, errors: 0 });
  assert.equal(await fs.readFile(path.join(root, "文章库", "2026-09-03_旧文章：可读目录", "article.md"), "utf8"), "# 旧文章\n");
  assert.equal(await fs.readFile(path.join(legacy, "article.md"), "utf8"), "# 旧文章\n");
  assert.deepEqual(await migrateLegacyLibrary(root), { migrated: 0, skipped: 1, errors: 0 });
});
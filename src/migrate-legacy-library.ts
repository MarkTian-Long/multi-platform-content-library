import fs from "node:fs/promises";
import path from "node:path";
import type { ArticleRecord } from "./article.js";
import { articleDirectoryName, type ArticleManifest } from "./article-library.js";
import { resolveLibraryRoot } from "./config.js";
import { isPathWithin } from "./url-policy.js";

export type MigrationResult = { migrated: number; skipped: number; errors: number };

export async function migrateLegacyLibrary(projectRoot: string): Promise<MigrationResult> {
  const legacyRoot = path.resolve(projectRoot, "article-library");
  const targetRoot = resolveLibraryRoot(projectRoot);
  const entries = await fs.readdir(legacyRoot, { withFileTypes: true }).catch(() => []);
  const result: MigrationResult = { migrated: 0, skipped: 0, errors: 0 };
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = path.resolve(legacyRoot, entry.name);
    if (!isPathWithin(legacyRoot, source)) { result.skipped += 1; continue; }
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(source, "manifest.json"), "utf8")) as ArticleManifest;
      if (!/^[a-f0-9]{24}$/.test(manifest.articleId) || !manifest.title || !manifest.extractedAt) { result.skipped += 1; continue; }
      await fs.access(path.join(source, "article.md"));
      const record = { title: manifest.title, extractedAt: manifest.extractedAt } as ArticleRecord;
      const target = path.resolve(targetRoot, articleDirectoryName(record));
      if (!isPathWithin(targetRoot, target)) { result.skipped += 1; continue; }
      try {
        await fs.access(target);
        result.skipped += 1;
      } catch {
        await fs.mkdir(targetRoot, { recursive: true });
        await fs.cp(source, target, { recursive: true, errorOnExist: true });
        result.migrated += 1;
      }
    } catch { result.errors += 1; }
  }
  return result;
}
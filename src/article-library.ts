import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ArticleRecord, CaptureStatus } from "./article.js";
import { isPathWithin } from "./url-policy.js";
import { renderArticleMarkdown } from "./markdown.js";

export interface ArticleMetadata { articleId: string; title: string; sourceUrl: string; status: CaptureStatus; extractedAt: string; }
export interface ArticleManifest extends ArticleMetadata { contentHash: string; }

function idFor(record: ArticleRecord): { id: string; contentHash: string } {
  const contentHash = crypto.createHash("sha256").update(record.markdown).digest("hex");
  const id = crypto.createHash("sha256").update(new URL(record.sourceUrl).toString() + contentHash).digest("hex").slice(0, 24);
  return { id, contentHash };
}

export async function saveArticle(root: string, record: ArticleRecord): Promise<{ articleId: string; directory: string; manifest: ArticleManifest }> {
  const { id, contentHash } = idFor(record);
  await fs.mkdir(root, { recursive: true });
  const directory = path.resolve(root, id);
  const temp = path.resolve(root, `.tmp-${id}-${crypto.randomUUID()}`);
  const manifest: ArticleManifest = { articleId: id, title: record.title, sourceUrl: record.sourceUrl, status: record.status, extractedAt: record.extractedAt, contentHash };
  try {
    await fs.mkdir(temp);
    await Promise.all([
      fs.writeFile(path.join(temp, "article.md"), renderArticleMarkdown(record), "utf8"),
      fs.writeFile(path.join(temp, "source.html"), record.sourceHtml ?? "", "utf8"),
      fs.writeFile(path.join(temp, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8")
    ]);
    await fs.rename(temp, directory);
  } catch (error) {
    await fs.rm(temp, { recursive: true, force: true });
    throw error;
  }
  return { articleId: id, directory, manifest };
}

export async function findArticles(root: string, query: string): Promise<ArticleMetadata[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const result: ArticleMetadata[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{24}$/.test(entry.name)) continue;
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(root, entry.name, "manifest.json"), "utf8")) as ArticleMetadata;
      if (!query || `${metadata.title} ${metadata.sourceUrl}`.toLowerCase().includes(query.toLowerCase())) result.push(metadata);
    } catch { /* ignore incomplete records */ }
  }
  return result;
}

export async function readArticle(root: string, articleId: string): Promise<{ ok: true; markdown: string; manifest: ArticleManifest } | { ok: false; reason: string }> {
  const directory = path.resolve(root, articleId);
  if (!/^[a-f0-9]{24}$/.test(articleId) || !isPathWithin(root, directory)) return { ok: false, reason: "文章标识无效" };
  try {
    return { ok: true, markdown: await fs.readFile(path.join(directory, "article.md"), "utf8"), manifest: JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8")) as ArticleManifest };
  } catch { return { ok: false, reason: "文章记录不存在或不完整" }; }
}

import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { ArticleRecord } from "./article.js";
import { articleDirectoryName, type ArticleManifest } from "./article-library.js";
import { isPathWithin } from "./url-policy.js";
import { resolveLibraryRoot } from "./config.js";
import { resolveUnifiedArticleRoot } from "./article-root.js";
import { atomicJson, containedFile, contentDirectory, contentIdentity, listManifests, saveContent, writableFile } from "./content-library.js";
import { parseContentLinks } from "./content-input.js";
import { articleMarkdownBody } from "./markdown.js";
import { selectReadingPdf } from "./content-reading.js";
import type { CapturedContent, ContentAsset, ContentManifest } from "./content-types.js";
import { tryContentMaintenance } from "./content-jobs.js";

export type MigrationResult = { migrated: number; skipped: number; errors: number };

const ARTICLE_ID = /^[a-f0-9]{24}$/;
const articleIds = (article: ArticleManifest): string[] => [article.articleId, ...(Array.isArray(article.articleIds) ? article.articleIds : [])].filter(id => typeof id === "string" && ARTICLE_ID.test(id));

async function readLegacyManifest(directory: string): Promise<ArticleManifest> {
  const file = await containedFile(directory, "manifest.json");
  if ((await fs.stat(file)).size > 8 * 1024 * 1024) throw new Error("旧文章清单过大，原件仍保留");
  const article = JSON.parse(await fs.readFile(file, "utf8")) as ArticleManifest;
  if (!article || !ARTICLE_ID.test(article.articleId) || typeof article.title !== "string" || !article.title.trim()
    || typeof article.extractedAt !== "string" || !Number.isFinite(Date.parse(article.extractedAt))
    || typeof article.sourceUrl !== "string" || !parseContentLinks(article.sourceUrl).some(input => input.platform === "wechat")) throw new Error("旧文章清单无效");
  return article;
}

async function readCanonicalArticle(directory: string, contentId: string): Promise<ArticleManifest | undefined> {
  try {
    const article = await readLegacyManifest(directory);
    if (article.contentId !== contentId) throw new Error("旧文章映射与正式资料身份不一致");
    return article;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Refer to the local originals directly; saveContent copies them without modifying the source. */
async function localLegacyContent(directory: string, article: ArticleManifest): Promise<CapturedContent> {
  const input = parseContentLinks(article.sourceUrl).find(value => value.platform === "wechat")!;
  const markdownFile = article.markdownFile ?? "article.md", markdown = await containedFile(directory, markdownFile);
  if ((await fs.stat(markdown)).size > 4 * 1024 * 1024) throw new Error("旧文章正文过大，原件仍保留");
  const assets: ContentAsset[] = [
    { id: "wechat-source-markdown", role: "source", status: "saved", path: markdownFile, provenance: "original" },
    { id: "wechat-source-manifest", role: "source", status: "saved", path: "manifest.json", provenance: "original" }
  ];
  const html = article.htmlFile ?? "source.html";
  try { await containedFile(directory, html); assets.push({ id: "wechat-source-html", role: "source", status: "saved", path: html, provenance: "original" }); }
  catch (error) { if (article.htmlFile || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const image of article.images ?? []) assets.push({ id: `image-${image.index}`, role: "image", status: image.status === "saved" ? "saved" : "failed", path: image.localPath, sourceUrl: image.sourceUrl, reason: image.reason, provenance: "original" });
  for (const video of article.videos ?? []) assets.push({ id: `video-${video.videoId ?? video.index}`, role: "video", status: video.status === "saved" ? "saved" : "unavailable", path: video.localPath, reason: video.reason, provenance: "original" });
  if (article.pdf?.status === "saved") assets.push({ id: "reading-pdf", role: "pdf", status: "saved", path: article.pdf.path, provenance: "generated" });
  if (new Set(assets.map(asset => asset.id)).size !== assets.length) throw new Error("旧文章资源标识重复");
  for (const asset of assets) if (asset.status === "saved") {
    if (!asset.path) throw new Error("旧文章缺少已保存文件路径");
    const file = await containedFile(directory, asset.path);
    if (!(await fs.stat(file)).size) throw new Error("旧文章已保存文件为空");
  }
  return { platform: "wechat", kind: "article", nativeId: input.nativeId ?? article.articleId, canonicalUrl: input.canonicalUrl, sourceUrl: article.sourceUrl,
    title: article.title, capturedAt: article.extractedAt, markdown: articleMarkdownBody(await fs.readFile(markdown, "utf8"), article), assets,
    warnings: article.status === "complete" ? [] : ["旧文章采集记录未标为完整，已保留本地原件"], coverage: { legacyArticleId: article.articleId } };
}

async function addArticleAliases(directory: string, saved: ContentManifest, incoming: ArticleManifest): Promise<void> {
  const prior = await readCanonicalArticle(directory, saved.contentId), base = prior ?? incoming;
  const aliases = [...new Set([...articleIds(base), ...articleIds(incoming)])];
  if (prior) { await atomicJson(await writableFile(directory, "manifest.json"), { ...prior, articleIds: aliases }); return; }
  const asset = (id: string) => saved.assets.find(value => value.id === id), pdf = selectReadingPdf(saved.assets);
  const article: ArticleManifest = { ...base, contentId: saved.contentId, title: saved.title, sourceUrl: saved.sourceUrl, extractedAt: saved.capturedAt, contentHash: saved.contentHash,
    articleIds: aliases, status: saved.status === "completed" ? "complete" : saved.status === "failed" ? "empty" : "partial",
    markdownFile: saved.markdownFile, htmlFile: asset("wechat-source-html")?.path,
    images: base.images?.map(image => { const local = asset(`image-${image.index}`); return { ...image, localPath: local?.path, status: local?.status === "saved" ? "saved" : "failed" }; }),
    videos: base.videos?.map(video => { const local = asset(`video-${video.videoId ?? video.index}`); return { ...video, localPath: local?.path, status: local?.status === "saved" ? "saved" : "not_saved" }; }),
    pdf: pdf?.path ? { status: "saved", path: pdf.path } : base.pdf?.status === "failed" ? base.pdf : undefined };
  await atomicJson(await writableFile(directory, "manifest.json"), article);
}

async function migrateToCanonical(legacyRoot: string, root: string, entries: Dirent[]): Promise<MigrationResult> {
  const result: MigrationResult = { migrated: 0, skipped: 0, errors: 0 }, known = await listManifests(root), knownIds = new Set<string>();
  for (const entry of known) {
    if (entry.manifest.platform !== "wechat") continue;
    try { const article = await readCanonicalArticle(entry.directory, entry.manifest.contentId); if (article) for (const id of articleIds(article)) knownIds.add(id); }
    catch { /* An unreadable compatibility file is retained and is never used as proof of a migrated ID. */ }
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      const source = path.join(legacyRoot, entry.name), article = await readLegacyManifest(source);
      if (articleIds(article).every(id => knownIds.has(id))) { result.skipped++; continue; }
      const local = await localLegacyContent(source, article);
      const input = parseContentLinks(article.sourceUrl).find(value => value.platform === "wechat")!;
      const id = contentIdentity({ platform: "wechat", nativeId: input.nativeId ?? article.articleId, canonicalUrl: input.canonicalUrl });
      const current = known.find(value => value.manifest.platform === "wechat" && (value.manifest.contentId === id || value.manifest.canonicalUrl === input.canonicalUrl));
      if (current) await addArticleAliases(current.directory, current.manifest, article);
      else {
        const saved = await saveContent(root, local, source), directory = await contentDirectory(root, saved.contentId);
        await addArticleAliases(directory, saved, article); known.push({ directory, manifest: saved });
      }
      for (const id of articleIds(article)) knownIds.add(id); result.migrated++;
    } catch { result.errors++; }
  }
  return result;
}

export async function migrateLegacyLibrary(projectRoot: string): Promise<MigrationResult> {
  const legacyRoot = path.resolve(projectRoot, "article-library");
  const targetRoot = path.resolve(projectRoot, "文章库");
  const entries = await fs.readdir(legacyRoot, { withFileTypes: true }).catch(() => []);
  const result: MigrationResult = { migrated: 0, skipped: 0, errors: 0 };
  if (!entries.length) return result;
  const canonical = await resolveUnifiedArticleRoot(resolveLibraryRoot(projectRoot));
  if (canonical) {
    const attempt = await tryContentMaintenance(canonical, () => migrateToCanonical(legacyRoot, canonical, entries));
    return attempt.acquired ? attempt.value : result;
  }
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

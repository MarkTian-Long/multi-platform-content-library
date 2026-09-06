import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ArticleRecord, CaptureStatus } from "./article.js";
import { downloadArticleImages, type ImageFetcher, type SavedArticleImage } from "./article-images.js";
import type { PdfStatus } from "./article-pdf.js";
import { isPathWithin } from "./url-policy.js";
import { renderArticleMarkdown } from "./markdown.js";
import { downloadArticleVideos, renderVideoMarkdown, sanitizeArticleVideoHtml, type SavedArticleVideo, type VideoFetcher } from "./article-videos.js";

export interface ArticleMetadata { articleId: string; title: string; sourceUrl: string; status: CaptureStatus; extractedAt: string; directory?: string; }
export interface ArticleManifest extends ArticleMetadata { contentHash: string; images?: SavedArticleImage[]; videos?: SavedArticleVideo[]; pdf?: PdfStatus; lastPdfError?: string; markdownFile?: string; }
export interface SaveArticleOptions { fetcher?: ImageFetcher; videoFetcher?: VideoFetcher; }

export function articleDirectoryName(record: Pick<ArticleRecord, "title" | "extractedAt">, copy = 1): string {
  const date = record.extractedAt.slice(0, 10);
  const title = record.title.replace(/[<>:"/\\|?*\x00-\x1F]/g, "").replace(/[. ]+$/g, "").slice(0, 48) || "未命名文章";
  return `${date}_${title}${copy > 1 ? `（${copy}）` : ""}`;
}
export function articleFileName(title: string, extension: "md" | "pdf"): string {
  const safeTitle = title.replace(/[<>:"/\\|?*\x00-\x1F]/g, "").replace(/[. ]+$/g, "").slice(0, 80) || "未命名文章";
  return `${safeTitle}.${extension}`;
}

function idFor(record: ArticleRecord): { id: string; contentHash: string } {
  const contentHash = crypto.createHash("sha256").update(record.markdown).digest("hex");
  const id = crypto.createHash("sha256").update(new URL(record.sourceUrl).toString() + contentHash).digest("hex").slice(0, 24);
  return { id, contentHash };
}

function withLocalImageLinks(record: ArticleRecord, images: SavedArticleImage[]): ArticleRecord {
  let markdown = record.markdown;
  for (const image of images) if (image.status === "saved" && image.localPath) markdown = markdown.split(image.sourceUrl).join(image.localPath);
  return { ...record, markdown };
}

async function directoryFor(root: string, record: ArticleRecord, articleId: string): Promise<{ directory: string; existing?: ArticleManifest }> {
  for (let copy = 1; copy < 1000; copy += 1) {
    const directory = path.resolve(root, articleDirectoryName(record, copy));
    try {
      const existing = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8")) as ArticleManifest;
      if (existing.articleId === articleId) return { directory, existing };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { directory };
    }
  }
  throw new Error("文章目录冲突过多");
}

export async function saveArticle(root: string, record: ArticleRecord, options: SaveArticleOptions = {}): Promise<{ articleId: string; directory: string; manifest: ArticleManifest }> {
  const { id, contentHash } = idFor(record);
  await fs.mkdir(root, { recursive: true });
  const selected = await directoryFor(root, record, id);
  if (selected.existing) {
    const manifest = selected.existing;
    const retainedImages: SavedArticleImage[] = [];
    const retryImages = [];
    for (const image of record.images ?? []) {
      const previous = manifest.images?.find((item) => item.index === image.index && item.sourceUrl === image.sourceUrl && item.status === "saved");
      const localPath = previous?.localPath ? path.resolve(selected.directory, previous.localPath) : undefined;
      const exists = localPath && isPathWithin(selected.directory, localPath) && await fs.stat(localPath).then((stat) => stat.isFile() && stat.size > 0, () => false);
      if (previous && exists) retainedImages.push(previous); else retryImages.push(image);
    }
    const downloadedImages = await downloadArticleImages(retryImages, path.join(selected.directory, "images"), options.fetcher);
    const images = [...retainedImages, ...downloadedImages].sort((a, b) => a.index - b.index);
    const videos = await downloadArticleVideos(record, path.join(selected.directory, "videos"), options.videoFetcher, { existingVideos: manifest.videos });
    manifest.images = images;
    // An older extraction may omit video metadata; keep already-saved evidence in that case.
    if (record.videos?.length) manifest.videos = videos;
    manifest.status = record.status === "partial" || images.some((image) => image.status === "failed") || (manifest.videos ?? []).some((video) => video.status !== "saved") ? "partial" : record.status;
    const localRecord = withLocalImageLinks(record, images);
    localRecord.markdown = renderVideoMarkdown(localRecord.markdown, manifest.videos ?? []);
    localRecord.status = manifest.status;
    await fs.writeFile(path.join(selected.directory, manifest.markdownFile ?? "article.md"), renderArticleMarkdown(localRecord), "utf8");
    if (record.sourceHtml) await fs.writeFile(path.join(selected.directory, "source.html"), sanitizeArticleVideoHtml(record.sourceHtml, record.sourceUrl), "utf8");
    await writeArticleManifest(selected.directory, manifest);
    return { articleId: id, directory: selected.directory, manifest };
  }
  const temp = path.resolve(root, `.tmp-${id}-${crypto.randomUUID()}`);
  const imagesDirectory = path.join(temp, "images");
  try {
    await fs.mkdir(temp);
    const images = await downloadArticleImages(record.images, imagesDirectory, options.fetcher);
    const videos = await downloadArticleVideos(record, path.join(temp, "videos"), options.videoFetcher);
    const status = record.status === "partial" || images.some((image) => image.status === "failed") || videos.some((video) => video.status !== "saved") ? "partial" : record.status;
    const manifest: ArticleManifest = { articleId: id, title: record.title, sourceUrl: record.sourceUrl, status, extractedAt: record.extractedAt, contentHash, images, videos, markdownFile: articleFileName(record.title, "md") };
    const localRecord = withLocalImageLinks(record, images);
    localRecord.markdown = renderVideoMarkdown(localRecord.markdown, videos);
    localRecord.status = status;
    const markdownFile = articleFileName(record.title, "md");
    await Promise.all([
      fs.writeFile(path.join(temp, markdownFile), renderArticleMarkdown(localRecord), "utf8"),
      fs.writeFile(path.join(temp, "source.html"), sanitizeArticleVideoHtml(record.sourceHtml ?? "", record.sourceUrl), "utf8"),
      fs.writeFile(path.join(temp, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8")
    ]);
    await fs.rename(temp, selected.directory);
    return { articleId: id, directory: selected.directory, manifest };
  } catch (error) { await fs.rm(temp, { recursive: true, force: true }).catch(() => {}); throw error; }
}

export async function writeArticleManifest(directory: string, manifest: ArticleManifest): Promise<void> { await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8"); }

async function records(root: string): Promise<Array<{ directory: string; manifest: ArticleManifest }>> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const result: Array<{ directory: string; manifest: ArticleManifest }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.resolve(root, entry.name);
    if (!isPathWithin(root, directory)) continue;
    try { result.push({ directory, manifest: JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8")) as ArticleManifest }); } catch { }
  }
  return result.sort((a, b) => b.manifest.extractedAt.localeCompare(a.manifest.extractedAt));
}

export async function findArticles(root: string, query: string): Promise<ArticleMetadata[]> { const needle = query.toLowerCase(); return (await records(root)).map(({ directory, manifest }) => ({ ...manifest, directory })).filter((item) => !needle || `${item.title} ${item.sourceUrl}`.toLowerCase().includes(needle)); }
export async function findArticleDirectory(root: string, articleId: string): Promise<string | undefined> { return (await records(root)).find(({ manifest }) => manifest.articleId === articleId)?.directory; }
export async function readArticle(root: string, articleId: string): Promise<{ ok: true; markdown: string; manifest: ArticleManifest } | { ok: false; reason: string }> { if (!/^[a-f0-9]{24}$/.test(articleId)) return { ok: false, reason: "文章标识无效" }; const found = (await records(root)).find(({ manifest }) => manifest.articleId === articleId); if (!found) return { ok: false, reason: "文章记录不存在或不完整" }; try { return { ok: true, markdown: await fs.readFile(path.join(found.directory, found.manifest.markdownFile ?? "article.md"), "utf8"), manifest: found.manifest }; } catch { return { ok: false, reason: "文章记录不存在或不完整" }; } }

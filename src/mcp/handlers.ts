import { resolveLibraryRoot, resolveRuntimeRoot } from "../config.js";
import { validateArticleUrl } from "../url-policy.js";
import { saveArticle, findArticles, readArticle, writeArticleManifest, type ArticleMetadata } from "../article-library.js";
import { generateArticlePdf, type PdfStatus } from "../article-pdf.js";
import { openEdgePage } from "../browser/edge.js";
import { captureRenderedPage } from "../browser/capture-page.js";
import { migrateLegacyLibrary } from "../migrate-legacy-library.js";
import type { CaptureStatus } from "../article.js";

export type CaptureResult = { status: CaptureStatus; articleId?: string; title?: string; reason?: string; pdf?: PdfStatus };
export type HandlerDeps = { capture?: (url: string) => Promise<CaptureResult>; find?: (query: string) => Promise<ArticleMetadata[]>; read?: (articleId: string) => ReturnType<typeof readArticle>; };
const runtimeRoot = () => resolveRuntimeRoot();
const libraryRoot = () => resolveLibraryRoot(runtimeRoot());
async function ensureLegacyArticlesAreVisible(): Promise<void> { await migrateLegacyLibrary(runtimeRoot()); }

async function defaultCapture(url: string): Promise<CaptureResult> {
  await ensureLegacyArticlesAreVisible();
  const { context, page } = await openEdgePage(runtimeRoot());
  try {
    const record = await captureRenderedPage(page, url);
    if (!record.markdown || !["complete", "partial"].includes(record.status)) return { status: record.status, title: record.title, reason: record.error ?? "未提取到正文" };
    const saved = await saveArticle(libraryRoot(), record);
    const pdf = await generateArticlePdf(saved.directory, saved.manifest);
    saved.manifest.pdf = pdf;
    await writeArticleManifest(saved.directory, saved.manifest);
    return { status: record.status, articleId: saved.articleId, title: record.title, pdf };
  } finally { await context.close(); }
}
export async function captureWechatArticle(input: { url: string }, deps: HandlerDeps = {}): Promise<CaptureResult> { const validation = validateArticleUrl(input.url); if (!validation.ok) return { status: "failed", reason: validation.reason }; try { return await (deps.capture ?? defaultCapture)(validation.url.toString()); } catch { return { status: "failed", reason: "文章采集失败，请稍后重试" }; } }
export async function findSavedArticles(input: { query: string }, deps: HandlerDeps = {}): Promise<ArticleMetadata[]> { if (!deps.find) await ensureLegacyArticlesAreVisible(); return (deps.find ?? ((query) => findArticles(libraryRoot(), query)))(input.query); }
export async function readSavedArticle(input: { articleId: string }, deps: HandlerDeps = {}) { if (!deps.read) await ensureLegacyArticlesAreVisible(); return (deps.read ?? ((articleId) => readArticle(libraryRoot(), articleId)))(input.articleId); }
export async function regenerateSavedPdf(articleId: string): Promise<PdfStatus | { status: "failed"; reason: string }> { const article = await readSavedArticle({ articleId }); if (!article.ok) return { status: "failed", reason: article.reason }; const directory = await (async () => { const { findArticleDirectory } = await import("../article-library.js"); return findArticleDirectory(libraryRoot(), articleId); })(); if (!directory) return { status: "failed", reason: "文章记录不存在" }; const pdf = await generateArticlePdf(directory, article.manifest); article.manifest.pdf = pdf; await writeArticleManifest(directory, article.manifest); return pdf; }
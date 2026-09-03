import { resolveLibraryRoot } from "../config.js";
import { validateArticleUrl } from "../url-policy.js";
import { saveArticle, findArticles, readArticle, type ArticleMetadata } from "../article-library.js";
import { openEdgePage } from "../browser/edge.js";
import { captureRenderedPage } from "../browser/capture-page.js";
import type { CaptureStatus } from "../article.js";

export type CaptureResult = { status: CaptureStatus; articleId?: string; title?: string; reason?: string };
export type HandlerDeps = {
  capture?: (url: string) => Promise<CaptureResult>;
  find?: (query: string) => Promise<ArticleMetadata[]>;
  read?: (articleId: string) => ReturnType<typeof readArticle>;
};

const libraryRoot = () => resolveLibraryRoot(process.cwd());

async function defaultCapture(url: string): Promise<CaptureResult> {
  const { context, page } = await openEdgePage(process.cwd());
  try {
    const record = await captureRenderedPage(page, url);
    if (!record.markdown || !["complete", "partial"].includes(record.status)) return { status: record.status, title: record.title, reason: record.error ?? "未提取到正文" };
    const saved = await saveArticle(libraryRoot(), record);
    return { status: record.status, articleId: saved.articleId, title: record.title };
  } finally { await context.close(); }
}

export async function captureWechatArticle(input: { url: string }, deps: HandlerDeps = {}): Promise<CaptureResult> {
  const validation = validateArticleUrl(input.url);
  if (!validation.ok) return { status: "failed", reason: validation.reason };
  try { return await (deps.capture ?? defaultCapture)(validation.url.toString()); }
  catch { return { status: "failed", reason: "文章采集失败，请稍后重试" }; }
}

export async function findSavedArticles(input: { query: string }, deps: HandlerDeps = {}): Promise<ArticleMetadata[]> {
  return (deps.find ?? ((query) => findArticles(libraryRoot(), query)))(input.query);
}

export async function readSavedArticle(input: { articleId: string }, deps: HandlerDeps = {}) {
  return (deps.read ?? ((articleId) => readArticle(libraryRoot(), articleId)))(input.articleId);
}

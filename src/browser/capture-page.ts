import { extractRenderedArticle } from "../extract-article.js";
import type { ArticleRecord } from "../article.js";

export interface RenderedPage { goto(url: string, options?: Record<string, unknown>): Promise<unknown>; waitForSelector(selector: string, options?: Record<string, unknown>): Promise<unknown>; content(): Promise<string>; title(): Promise<string>; close(): Promise<void>; }

export async function captureRenderedPage(page: RenderedPage, url: string, extractedAt = new Date()): Promise<ArticleRecord> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("#js_content", { state: "visible", timeout: 30000 });
    return extractRenderedArticle(await page.content(), url, extractedAt);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "页面加载失败";
    return { title: "未命名文章", markdown: "", sourceUrl: url, extractedAt: extractedAt.toISOString(), status: /timeout/i.test(reason) ? "timeout" : "failed", error: /timeout/i.test(reason) ? "页面加载超时" : "页面无法读取" };
  } finally { await page.close(); }
}

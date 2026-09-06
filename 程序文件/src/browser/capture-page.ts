import { extractRenderedArticle } from "../extract-article.js";
import type { ArticleRecord } from "../article.js";
import { closeQuietly, describeError, isTimeoutError } from "../errors.js";

export interface RenderedPage { goto(url: string, options?: Record<string, unknown>): Promise<unknown>; waitForSelector(selector: string, options?: Record<string, unknown>): Promise<unknown>; waitForFunction?(script: string, arg?: unknown, options?: { timeout?: number }): Promise<unknown>; content(): Promise<string>; title(): Promise<string>; close(): Promise<void>; }

export async function captureRenderedPage(page: RenderedPage, url: string, extractedAt = new Date()): Promise<ArticleRecord> {
  let stage = "打开微信文章";
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    stage = "等待文章正文";
    await page.waitForSelector("#js_content", { state: "visible", timeout: 30000 });
    // WeChat can normally replace a rejected initial src with a playable rendition.
    // Do not snapshot/close during that recovery, or treat a transient media error
    // as readiness. Bound the wait so unsupported/lazy media never loses the text.
    stage = "等待视频初始化";
    await page.waitForFunction?.(`(() => {
      const selector = 'video, mp-video, span.video_iframe[id^="js_mp_video_container_"][vid]';
      const players = Array.from(document.querySelectorAll(selector.split(', ').map(s => '#js_content ' + s).join(', ')))
        .filter(element => !element.parentElement?.closest(selector)).slice(0, 20);
      return players.every(element => {
        const video = element.tagName === 'VIDEO' ? element : element.querySelector('video');
        return Boolean(video && !video.error && video.readyState >= 1 && (video.currentSrc || video.src));
      });
    })()`, undefined, { timeout: 15000 }).catch(() => {});
    stage = "提取文章正文";
    const html = await page.content();
    const article = extractRenderedArticle(html, url, extractedAt);
    article.sourceHtml = html;
    return article;
  } catch (error) {
    return { title: "未命名文章", markdown: "", sourceUrl: url, extractedAt: extractedAt.toISOString(), status: isTimeoutError(error) ? "timeout" : "failed", error: describeError(error, stage) };
  } finally { await closeQuietly(page); }
}

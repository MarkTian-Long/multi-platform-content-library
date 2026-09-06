import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { load, type CheerioAPI } from "cheerio";
import type { ArticleRecord, ArticleVideo } from "./article.js";

interface VideoCandidate { index: number; urls: string[]; }
const runtimeCandidates = new WeakMap<ArticleRecord, VideoCandidate[]>();
const WECHAT_PLAYER_CONTAINER = 'span.video_iframe[id^="js_mp_video_container_"]';
export type SavedArticleVideo = ArticleVideo;
export type VideoFetcher = (input: string, init?: RequestInit) => Promise<Response>;
export interface VideoDownloadOptions { maxVideoBytes?: number; maxTotalBytes?: number; maxVideos?: number; timeoutMs?: number; existingVideos?: SavedArticleVideo[]; }
export const VIDEO_DOWNLOAD_LIMITS = { maxVideoBytes: 100 * 1024 * 1024, maxTotalBytes: 500 * 1024 * 1024, maxVideos: 20, timeoutMs: 60_000, concurrency: 2 } as const;

class VideoDownloadError extends Error { }

function httpUrl(value: string | undefined, base: string): URL | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value, base);
    return /^(https?:)$/.test(url.protocol) && !url.username && !url.password ? url : undefined;
  } catch { return undefined; }
}

function knownVideoFrame(url: URL | undefined): boolean {
  if (!url) return false;
  return (url.hostname === "v.qq.com" && /\/(?:iframe|txp\/iframe)\/player\.html$/.test(url.pathname))
    || (url.hostname === "mp.weixin.qq.com" && (url.pathname === "/mp/videoplayer"
      || (url.pathname === "/mp/readtemplate" && /video_player/.test(url.searchParams.get("t") ?? ""))));
}

export function videoPlaceholder(video: Pick<ArticleVideo, "index">): string {
  return `视频 ${video.index}：请在原文观看（尚未离线保存）`;
}

/** Signed media URLs remain here only while the capture is being saved. */
export function attachArticleVideoCandidates(article: ArticleRecord, candidates: VideoCandidate[]): void {
  runtimeCandidates.set(article, candidates);
}

export function extractArticleVideos($: CheerioAPI, content: ReturnType<CheerioAPI>, sourceUrl: string): { videos: ArticleVideo[]; candidates: VideoCandidate[] } {
  const videos: ArticleVideo[] = [];
  const candidates: VideoCandidate[] = [];
  const identities = new Map<string, number>();
  content.find("video, mp-video, iframe").each((offset, node) => {
    const element = $(node);
    // Replacing a player also detaches any duplicate media nodes in its controls.
    if (!element.parents().toArray().some((parent) => parent === content[0])) return;
    // A native video can be nested inside the custom WeChat player.
    if (element.parents("video, mp-video").length) return;
    const frameUrl = httpUrl(element.attr("src") ?? element.attr("data-src"), sourceUrl);
    if (element.is("iframe") && !knownVideoFrame(frameUrl)) return;
    const player = element.closest(WECHAT_PLAYER_CONTAINER);
    const replacement = player.length && player.parents().toArray().some((parent) => parent === content[0]) ? player : element;
    const urls = [...new Set([element, ...replacement.find("video, source").toArray().map((child) => $(child))]
      .flatMap((item) => ["src", "data-src", "data-video-src"].map((attribute) => httpUrl(item.attr(attribute), sourceUrl)))
      .filter((url): url is URL => !!url && !knownVideoFrame(url)).map((url) => url.toString()))];
    const identityElements = replacement.is(WECHAT_PLAYER_CONTAINER) ? [replacement, element] : [element];
    const rawId = identityElements.flatMap((item) => ["data-vid", "vid", "data-videoid", "data-video-id", "video_id"]
      .map((key) => item.attr(key))).find(Boolean) ?? frameUrl?.searchParams.get("vid") ?? undefined;
    const videoId = rawId && /^[a-zA-Z0-9_-]{1,128}$/.test(rawId) ? rawId : undefined;
    const firstUrl = urls[0] ? new URL(urls[0]) : undefined;
    const key = videoId ? `vid:${videoId}` : firstUrl ? `url:${firstUrl.origin}${firstUrl.pathname}` : `element:${offset}`;
    let index = identities.get(key);
    if (!index) {
      index = videos.length + 1;
      identities.set(key, index);
      const provider = element.is("mp-video") || firstUrl?.hostname === "mpvideo.qpic.cn" || frameUrl?.hostname === "mp.weixin.qq.com"
        ? "wechat" : frameUrl?.hostname === "v.qq.com" ? "tencent" : "html5";
      videos.push({ index, label: `视频 ${index}`, provider, sourceArticleUrl: sourceUrl, ...(videoId ? { videoId } : {}), sourceKey: createHash("sha256").update(key).digest("hex"), status: "not_saved" });
      candidates.push({ index, urls });
    } else {
      const existing = candidates[index - 1];
      existing.urls = [...new Set([...existing.urls, ...urls])];
    }
    const paragraph = $("<p></p>").attr("data-article-video-index", String(index));
    paragraph.append($("<a></a>").attr("href", sourceUrl).text(videoPlaceholder({ index })));
    replacement.replaceWith(paragraph);
  });
  return { videos, candidates };
}

function downloadableUrl(value: string): URL | undefined {
  const url = httpUrl(value, "https://mp.weixin.qq.com");
  if (!url || url.port || /\.(?:m3u8|mpd)(?:$|\/)/i.test(url.pathname)) return undefined;
  const allowedHosts = ["mpvideo.qpic.cn", "video.qq.com", "tc.qq.com", "video.gtimg.com"];
  return allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url : undefined;
}

function bounded(value: number | undefined, maximum: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.min(Math.floor(value!), maximum) : maximum;
}

function extensionForVideo(contentType: string): string | undefined {
  const type = contentType.split(";")[0].trim().toLowerCase();
  return ({ "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/x-m4v": "m4v", "video/ogg": "ogv" } as Record<string, string>)[type];
}

function expectedVideoBytes(response: Response): number | undefined {
  const contentLength = response.headers.get("content-length");
  let expected = contentLength !== null && /^\d+$/.test(contentLength) ? Number(contentLength) : undefined;
  if (response.status === 206) {
    const range = /^bytes 0-(\d+)\/(\d+)$/i.exec(response.headers.get("content-range")?.trim() ?? "");
    const end = Number(range?.[1]);
    const total = Number(range?.[2]);
    if (!range || !Number.isSafeInteger(end) || !Number.isSafeInteger(total) || total <= 0 || end !== total - 1) {
      throw new VideoDownloadError("视频服务仅返回片段或未确认完整范围，请在原文观看");
    }
    if (expected !== undefined && expected !== total) throw new VideoDownloadError("视频响应长度与完整范围不符，请在原文观看");
    expected = total;
  }
  // Fetch decodes content encodings but leaves Content-Length describing wire bytes.
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  return encoding && encoding !== "identity" ? undefined : expected;
}

function publicFailure(error: unknown, signal: AbortSignal): string {
  if (signal.aborted || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) return "视频下载超时，请在原文观看";
  return error instanceof VideoDownloadError ? error.message : "视频下载失败（网络或文件写入异常），请在原文观看";
}

async function videoResponse(url: string, sourceArticleUrl: string, fetcher: VideoFetcher, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (!downloadableUrl(current)) throw new VideoDownloadError("视频跳转地址不受支持，请在原文观看");
    const response = await fetcher(current, { redirect: "manual", signal, headers: { Referer: sourceArticleUrl } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      const next = httpUrl(response.headers.get("location") ?? undefined, current);
      if (!next || !downloadableUrl(next.toString())) throw new VideoDownloadError("视频跳转地址不受支持，请在原文观看");
      current = next.toString();
      continue;
    }
    // Enforce the same boundary for custom fetchers that followed a redirect.
    if (response.url && !downloadableUrl(response.url)) {
      await response.body?.cancel().catch(() => {});
      throw new VideoDownloadError("视频跳转地址不受支持，请在原文观看");
    }
    return response;
  }
  throw new VideoDownloadError("视频跳转次数过多，请在原文观看");
}

/** Stream public media only. No cookies, browser login, player API or HLS parsing. */
export async function downloadArticleVideos(article: ArticleRecord, directory: string, fetcher: VideoFetcher = fetch, options: VideoDownloadOptions = {}): Promise<SavedArticleVideo[]> {
  const videos = article.videos ?? [];
  if (!videos.length) return [];
  const limits = {
    maxVideoBytes: bounded(options.maxVideoBytes, VIDEO_DOWNLOAD_LIMITS.maxVideoBytes),
    maxTotalBytes: bounded(options.maxTotalBytes, VIDEO_DOWNLOAD_LIMITS.maxTotalBytes),
    maxVideos: bounded(options.maxVideos, VIDEO_DOWNLOAD_LIMITS.maxVideos),
    timeoutMs: bounded(options.timeoutMs, VIDEO_DOWNLOAD_LIMITS.timeoutMs)
  };
  const candidates = runtimeCandidates.get(article) ?? [];
  const results: SavedArticleVideo[] = new Array(videos.length);
  let position = 0;
  let totalBytes = 0;
  await fs.mkdir(directory, { recursive: true });

  const reusable = new Map<number, { localPath: string; bytes: number }>();
  for (const video of videos) {
    const previous = options.existingVideos?.find((entry) => entry.index === video.index && entry.status === "saved"
      && entry.sourceArticleUrl === video.sourceArticleUrl
      && ((video.sourceKey && video.sourceKey === entry.sourceKey) || (video.videoId && video.videoId === entry.videoId)));
    if (!previous?.localPath || !/^videos\/\d+\.(mp4|webm|mov|m4v|ogv)$/.test(previous.localPath)) continue;
    try {
      const existing = await fs.lstat(path.join(directory, path.basename(previous.localPath)));
      if (!existing.isFile() || existing.size <= 0 || (previous.bytes !== undefined && previous.bytes !== existing.size)
        || existing.size > limits.maxVideoBytes || totalBytes + existing.size > limits.maxTotalBytes) continue;
      totalBytes += existing.size;
      reusable.set(video.index, { localPath: previous.localPath, bytes: existing.size });
    } catch { /* Missing saved files are retried from the current rendered page. */ }
  }

  async function downloadOne(video: ArticleVideo, offset: number): Promise<SavedArticleVideo> {
    const metadata: ArticleVideo = { index: video.index, label: video.label, provider: video.provider, sourceArticleUrl: video.sourceArticleUrl, ...(video.videoId ? { videoId: video.videoId } : {}), ...(video.sourceKey ? { sourceKey: video.sourceKey } : {}), status: "not_saved" };
    const previous = reusable.get(video.index);
    if (previous) return { ...metadata, status: "saved", ...previous };
    if (offset >= limits.maxVideos) return { ...metadata, reason: "视频数量超过单篇保存上限，请在原文观看" };
    if (!Number.isSafeInteger(video.index) || video.index < 1) return { ...metadata, status: "failed", reason: "视频序号无效" };
    const urls = candidates.find((candidate) => candidate.index === video.index)?.urls.filter((url) => downloadableUrl(url)).slice(0, 3) ?? [];
    if (!urls.length) return { ...metadata, status: "unsupported", reason: "未发现可直接保存的公开视频文件，请在原文观看" };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), limits.timeoutMs);
    let reason = "视频下载失败，请在原文观看";
    try {
      for (const url of urls) {
        let filePath: string | undefined;
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
        let response: Response | undefined;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          if (totalBytes >= limits.maxTotalBytes) throw new VideoDownloadError("本篇视频总量超过保存上限，请在原文观看");
          if (controller.signal.aborted) throw new VideoDownloadError("视频下载超时，请在原文观看");
          response = await videoResponse(url, video.sourceArticleUrl, fetcher, controller.signal);
          if (!response.ok) throw new VideoDownloadError(`视频服务返回 HTTP ${response.status}，请在原文观看`);
          const extension = extensionForVideo(response.headers.get("content-type") ?? "");
          if (!extension) throw new VideoDownloadError("返回内容不是支持的视频文件，请在原文观看");
          const expectedBytes = expectedVideoBytes(response);
          const announcedBytes = Number(response.headers.get("content-length") ?? "0");
          if (Number.isFinite(announcedBytes) && announcedBytes > limits.maxVideoBytes) throw new VideoDownloadError("单个视频超过保存大小上限，请在原文观看");
          if (Number.isFinite(announcedBytes) && announcedBytes + totalBytes > limits.maxTotalBytes) throw new VideoDownloadError("本篇视频总量超过保存上限，请在原文观看");
          if (!response.body) throw new VideoDownloadError("视频响应没有内容，请在原文观看");
          const fileName = `${String(video.index).padStart(3, "0")}.${extension}`;
          const targetPath = path.join(directory, fileName);
          handle = await fs.open(targetPath, "wx");
          filePath = targetPath;
          reader = response.body.getReader();
          let bytes = 0;
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (bytes + chunk.value.byteLength > limits.maxVideoBytes) throw new VideoDownloadError("单个视频超过保存大小上限，请在原文观看");
            if (totalBytes + chunk.value.byteLength > limits.maxTotalBytes) throw new VideoDownloadError("本篇视频总量超过保存上限，请在原文观看");
            // Reserve bytes before awaiting disk I/O so concurrent streams share one limit.
            bytes += chunk.value.byteLength;
            totalBytes += chunk.value.byteLength;
            await handle.writeFile(chunk.value);
          }
          if (!bytes) throw new VideoDownloadError("视频文件为空，请在原文观看");
          if (expectedBytes !== undefined && bytes !== expectedBytes) throw new VideoDownloadError("视频下载不完整（实际长度与响应声明不符），请在原文观看");
          await handle.close();
          handle = undefined;
          return { ...metadata, status: "saved", localPath: `videos/${fileName}`, bytes };
        } catch (error) {
          reason = publicFailure(error, controller.signal);
          await handle?.close().catch(() => {});
          if (filePath) await fs.rm(filePath, { force: true }).catch(() => {});
          if (controller.signal.aborted) break;
        } finally {
          if (reader) await reader.cancel().catch(() => {});
          else await response?.body?.cancel().catch(() => {});
        }
      }
    } finally { clearTimeout(timeout); }
    return { ...metadata, status: "failed", reason };
  }

  async function worker(): Promise<void> {
    while (position < videos.length) {
      const offset = position++;
      results[offset] = await downloadOne(videos[offset], offset);
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(VIDEO_DOWNLOAD_LIMITS.concurrency, videos.length) }, () => worker()));
    return results;
  } finally { runtimeCandidates.delete(article); }
}

export function renderVideoMarkdown(markdown: string, videos: SavedArticleVideo[]): string {
  for (const video of videos) {
    if (video.status !== "saved" || !video.localPath || !/^videos\/\d+\.(mp4|webm|mov|m4v|ogv)$/.test(video.localPath)) continue;
    const original = `[${videoPlaceholder(video)}](${video.sourceArticleUrl})`;
    const local = `[视频 ${video.index}：打开本地视频文件](${video.localPath})（[原文观看](${video.sourceArticleUrl})）`;
    markdown = markdown.split(original).join(local);
  }
  return markdown;
}

/** The readable snapshot intentionally drops scripts and transient media credentials. */
export function sanitizeArticleVideoHtml(html: string, sourceUrl: string): string {
  const $ = load(html);
  extractArticleVideos($, $("#js_content").first(), sourceUrl);
  // Also clean older snapshots where only the inner video was replaced.
  $("#js_content").first().find(WECHAT_PLAYER_CONTAINER).each((_, node) => {
    const placeholder = $(node).find("p[data-article-video-index]").first();
    if (placeholder.length) $(node).replaceWith(placeholder.clone());
  });
  $("script, noscript, video, mp-video, iframe").remove();
  $("*").each((_, node) => {
    if (!("attribs" in node)) return;
    for (const [attribute, value] of Object.entries(node.attribs)) {
      if (attribute.toLowerCase().startsWith("on") || /(?:auth_key|auth_info|dis_t)=/i.test(value)) $(node).removeAttr(attribute);
    }
  });
  return $.html();
}

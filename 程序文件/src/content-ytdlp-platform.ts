import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CapturedContent, ContentAsset, ContentContext, ContentInput } from "./content-types.js";
import type { ContentToolRunResult } from "./content-tools.js";
import { runContentTool } from "./content-tools.js";
import { youtubeVideoReference } from "./content-input.js";
import { publicHttpUrl, savePublicAsset, fetchPublic } from "./content-network.js";
import { configuredYoutubeNetwork, youtubeMediaTransport } from "./content-youtube-transport.js";
import { atomicReplace, containedFile, ensureDirectory, fileHash, publicValue, writableFile } from "./content-library.js";
import { isPathWithin } from "./url-policy.js";
import { youtubeRetryAfter } from "./content-youtube-retry.js";

export interface YoutubePlatformDeps {
  ytDlpPath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  runTool?: (command: string, args: string[], context: ContentContext) => Promise<ContentToolRunResult>;
  probeMedia?: (file: string, context: ContentContext) => Promise<{ video: boolean; audio: boolean; durationSeconds?: number } | undefined>;
  /** Bounded public transport injection; byte limits and verification remain in savePublicAsset. */
  mediaTransport?: typeof fetchPublic;
}

export const YOUTUBE_MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024;
const ACQUISITION_TIMEOUT_MS = 10 * 60000;
type Format = { url: string; format_id?: string; ext: string; protocol: string; vcodec?: string; acodec?: string; height?: number; tbr?: number; filesize?: number; filesize_approx?: number; has_drm?: boolean; fragments?: unknown[] };
type Probe = { video: boolean; audio: boolean; durationSeconds?: number };
class YoutubeFailure extends Error { constructor(message: string, readonly status: ContentAsset["status"] = "failed") { super(message); } }

async function executable(runtimeRoot: string, name: string, configured?: string): Promise<string | undefined> {
  const names = process.platform === "win32" ? [`${name}.exe`, name] : [name];
  const candidates = [configured, ...names.map(file => path.join(runtimeRoot, "tools", file)), ...(process.env.PATH ?? "").split(path.delimiter).flatMap(folder => names.map(file => path.join(folder, file)))];
  for (const file of candidates) if (file && await fs.stat(file).then(stat => stat.isFile(), () => false)) return file;
  return undefined;
}

async function dedicatedCookies(runtimeRoot: string): Promise<string | undefined> {
  const profile = path.join(runtimeRoot, ".content-profile", "youtube");
  const candidate = path.join(profile, "cookies.txt");
  const stat = await fs.lstat(candidate).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!stat || !stat.size) return undefined;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) throw new YoutubeFailure("YouTube 专用 Cookie 文件不是安全的普通小文件");
  return containedFile(profile, "cookies.txt");
}

function selectedFormats(value: unknown, canMerge: boolean): Format[] {
  if (!Array.isArray(value)) throw new YoutubeFailure("未返回可下载的视频格式", "unavailable");
  const formats = value.filter((item): item is Format => {
    if (!item || typeof item !== "object" || typeof item.url !== "string" || item.has_drm || item.fragments?.length || !["http", "https"].includes(item.protocol) || !["mp4", "m4a"].includes(item.ext)) return false;
    try { const url = new URL(item.url); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
  });
  const hasVideo = (format: Format) => typeof format.vcodec === "string" && format.vcodec !== "none" && !!format.vcodec;
  const hasAudio = (format: Format) => typeof format.acodec === "string" && format.acodec !== "none" && !!format.acodec;
  const estimated = (format: Format) => Number.isFinite(format.filesize) && format.filesize! > 0 ? format.filesize! : Number.isFinite(format.filesize_approx) && format.filesize_approx! > 0 ? format.filesize_approx! : 0;
  const bounded = formats.filter(format => estimated(format) <= YOUTUBE_MAX_MEDIA_BYTES);
  const rank = (a: Format, b: Format) => (Number(b.height) || 0) - (Number(a.height) || 0) || (Number(b.tbr) || 0) - (Number(a.tbr) || 0);
  const progressive = bounded.filter(format => hasVideo(format) && hasAudio(format)).sort(rank)[0];
  const video = bounded.filter(format => hasVideo(format) && format.acodec === "none").sort(rank)[0];
  const audio = bounded.filter(format => hasAudio(format) && format.vcodec === "none").sort(rank)[0];
  if (canMerge && video && audio && estimated(video) + estimated(audio) <= YOUTUBE_MAX_MEDIA_BYTES && (!progressive || rank(video, progressive) < 0)) return [video, audio];
  if (progressive) return [progressive];
  if (video && audio && !canMerge) throw new YoutubeFailure("分离音视频需要 FFmpeg；未找到本机工具", "missing_dependency");
  throw new YoutubeFailure(formats.some(format => estimated(format) > YOUTUBE_MAX_MEDIA_BYTES) || video && audio ? "可选音视频超过 2 GiB 总量上限" : "没有可安全下载的 HTTP(S) MP4/M4A；分段流、DRM 或受限格式未下载", "unavailable");
}

async function localRunner(command: string, args: string[], context: ContentContext): Promise<ContentToolRunResult> {
  return runContentTool({ command, args, cwd: context.directory, signal: context.signal, timeoutMs: ACQUISITION_TIMEOUT_MS, maxOutputBytes: 2 * 1024 * 1024 });
}

async function probe(file: string, context: ContentContext, deps: YoutubePlatformDeps, command: string | undefined): Promise<Probe | undefined> {
  if (deps.probeMedia) return deps.probeMedia(file, context);
  if (!command) return undefined;
  const result = await (deps.runTool ?? localRunner)(command, ["-protocol_whitelist", "file,pipe", "-f", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", file], context);
  if (result.code || result.cancelled || result.timedOut || result.outputTruncated) return undefined;
  try { const parsed = JSON.parse(result.stdout); return { video: parsed.streams?.some((stream: { codec_type?: string }) => stream.codec_type === "video") === true, audio: parsed.streams?.some((stream: { codec_type?: string }) => stream.codec_type === "audio") === true, durationSeconds: Number(parsed.format?.duration) }; } catch { return undefined; }
}

/** Extract only one YouTube VOD; every media byte uses the existing public downloader. */
export async function acquireYoutube(input: ContentInput, context: ContentContext, deps: YoutubePlatformDeps = {}): Promise<CapturedContent> {
  const content: CapturedContent = { platform: input.platform, nativeId: input.nativeId, sourceUrl: input.url, canonicalUrl: input.canonicalUrl, title: "YouTube 视频", capturedAt: new Date().toISOString(), kind: "video", markdown: "", assets: [], warnings: [], coverage: { media: "not_attempted", subtitles: "not_supported: native YouTube subtitles", comments: "not_supported: native YouTube comments" } };
  const signal = AbortSignal.any([AbortSignal.timeout(ACQUISITION_TIMEOUT_MS), ...(context.signal ? [context.signal] : [])]);
  const current = { ...context, signal };
  let transaction: string | undefined;
  let root: string | undefined;
  let failureStage = "input";
  const rateLimited = () => {
    content.coverage!.access = "rate_limited";
    return new YoutubeFailure("YouTube请求过于频繁（HTTP 429），本次已停止自动重试。请稍后再试；平台要求验证时，在登录与依赖页选择YouTube专用浏览器", "unavailable");
  };
  try {
    signal.throwIfAborted();
    const reference = youtubeVideoReference(input.url);
    if (input.platform !== "youtube" || !reference || input.nativeId && input.nativeId !== reference.nativeId) throw new YoutubeFailure("只接受明确视频 ID 的 YouTube 单视频链接", "unavailable");
    await publicHttpUrl(reference.canonicalUrl, signal);
    content.nativeId = reference.nativeId; content.canonicalUrl = reference.canonicalUrl;
    const network = await configuredYoutubeNetwork(context.runtimeRoot), proxy = network.proxyUrl;
    const baseTransport = deps.mediaTransport ?? (proxy ? youtubeMediaTransport(proxy) : fetchPublic);
    const mediaTransport: typeof fetchPublic = async (url, init, requestSignal) => {
      const response = await baseTransport(url, init, requestSignal);
      if (response.status === 429) {
        const retryAfter=youtubeRetryAfter(response.headers.get("retry-after"));
        if(retryAfter)content.coverage!.retryAfter=retryAfter;
        await response.body?.cancel().catch(() => {});throw rateLimited();
      }
      return response;
    };
    const ytDlp = await executable(context.runtimeRoot, "yt-dlp", deps.ytDlpPath ?? process.env.CONTENT_YTDLP_PATH);
    if (!ytDlp) throw new YoutubeFailure("未找到 yt-dlp；请检查本机视频工具", "missing_dependency");
    if (Number(process.versions.node.split(".")[0]) < 22) throw new YoutubeFailure("当前 Node 版本低于 YouTube EJS 要求的 22", "missing_dependency");
    const ffprobe = deps.probeMedia ? undefined : await executable(context.runtimeRoot, "ffprobe", deps.ffprobePath ?? process.env.CONTENT_FFPROBE_PATH);
    if (!deps.probeMedia && !ffprobe) throw new YoutubeFailure("缺少 ffprobe，无法核验 YouTube 视频", "missing_dependency");
    const ffmpeg = await executable(context.runtimeRoot, "ffmpeg", deps.ffmpegPath ?? process.env.CONTENT_FFMPEG_PATH);
    await ensureDirectory(context.directory); root = await fs.realpath(context.directory);
    const runner = deps.runTool ?? localRunner;
    const cookieFile = await dedicatedCookies(context.runtimeRoot);
    current.onProgress?.("读取 YouTube 单视频元数据");
    failureStage = "metadata";
    // Ignore ambient configs/plugins and use bundled EJS with this already running Node.
    // Only an existing app-owned YouTube cookie file may be used. Never import a
    // default browser profile, or enable remote components, search or playlists.
    const metadataResult = await runner(ytDlp, ["--ignore-config", "--no-config-locations", "--no-plugin-dirs", "--no-remote-components", "--no-js-runtimes", "--js-runtimes", `node:${process.execPath}`, "--use-extractors", "^youtube$", "--default-search", "error", "--no-playlist", "--no-check-formats", "--skip-download", "--socket-timeout", "20", "--retries", "0", "--extractor-retries", "0", "--proxy", proxy ?? "", ...(cookieFile ? ["--cookies", cookieFile] : []), "--dump-single-json", "--", reference.canonicalUrl], current);
    signal.throwIfAborted();
    if (metadataResult.code || metadataResult.cancelled || metadataResult.timedOut || metadataResult.outputTruncated) {
      if (/HTTP\s+(?:Error\s+)?429\b|429:\s*Too Many Requests/i.test(metadataResult.stderr)) throw rateLimited();
      const detail = publicValue(metadataResult.stderr.trim().slice(-600));
      const status = /sign.?in|log.?in|confirm your age|members.only|authentication|not a bot/i.test(metadataResult.stderr) ? "login_required" : /no such option|javascript runtime|yt-dlp-ejs|ejs|challenge solver/i.test(detail) ? "missing_dependency" : "failed";
      if (status === "login_required") { content.coverage!.access = "verification_required"; throw new YoutubeFailure("该YouTube视频要求登录或验证，请在登录与依赖页选择YouTube专用浏览器，完成后重试原任务", status); }
      throw new YoutubeFailure(metadataResult.timedOut ? "YouTube 元数据读取超时" : metadataResult.outputTruncated ? "YouTube 元数据超过记录上限" : `YouTube 元数据读取失败：${detail || `退出码 ${metadataResult.code}`}`, status);
    }
    let metadata: Record<string, unknown>;
    try { metadata = JSON.parse(metadataResult.stdout); if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error(); } catch { throw new YoutubeFailure("YouTube 元数据不是有效对象"); }
    if (metadata.id !== reference.nativeId || metadata._type && metadata._type !== "video" || metadata.entries !== undefined || !(metadata.extractor_key === "Youtube" || metadata.extractor === "youtube")) throw new YoutubeFailure("元数据不是所提交的 YouTube 单视频");
    if (typeof metadata.webpage_url === "string" && youtubeVideoReference(metadata.webpage_url)?.nativeId !== reference.nativeId) throw new YoutubeFailure("元数据页面与视频身份不一致");
    if (metadata.is_live || ["is_live", "is_upcoming", "post_live"].includes(String(metadata.live_status))) throw new YoutubeFailure("直播、预告或尚未处理完成的视频暂不采集", "unavailable");
    const duration = metadata.duration;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) throw new YoutubeFailure("视频元数据缺少可核验的完整时长", "unavailable");
    content.title = typeof metadata.title === "string" ? metadata.title.replace(/\s+/g, " ").trim().slice(0, 240) || content.title : content.title;
    content.author = typeof metadata.uploader === "string" ? metadata.uploader.slice(0, 240) : undefined;
    content.markdown = typeof metadata.description === "string" ? metadata.description.trim() : "";
    content.parts = [{ id: reference.nativeId, title: content.title, status: "unavailable", durationSeconds: duration }];
    content.coverage!.metadata = "saved: single-video identity verified";
    content.coverage!.body = content.markdown ? "saved: original description" : "unavailable: no description";
    await current.onCheckpoint?.(content);
    const formats = selectedFormats(metadata.formats, !!ffmpeg);
    for (const format of formats) await publicHttpUrl(format.url, signal);
    transaction = path.dirname(await writableFile(root, `.youtube-downloads/${randomUUID()}/transaction`));
    const sources: string[] = []; let sourceBytes = 0;
    failureStage = "media";
    for (const [index, format] of formats.entries()) {
      signal.throwIfAborted(); current.onProgress?.(`保存 YouTube 音视频流 ${index + 1}/${formats.length}`);
      const asset = await savePublicAsset(format.url, transaction, `stream-${index + 1}`, index === 0 ? "video" : "audio", signal, YOUTUBE_MAX_MEDIA_BYTES - sourceBytes, undefined, mediaTransport);
      if (asset.status !== "saved" || !asset.path || !asset.bytes) throw new YoutubeFailure(asset.reason || "YouTube 媒体下载未完成", content.coverage!.access === "rate_limited" ? "unavailable" : asset.status === "failed" ? "failed" : "unavailable");
      sourceBytes += asset.bytes; sources.push(await containedFile(transaction, asset.path));
    }
    let output = sources[0];
    if (sources.length === 2) {
      failureStage = "merge";
      output = await writableFile(transaction, "merged.mp4.part");
      const merge = await runner(ffmpeg!, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-protocol_whitelist", "file,pipe", "-f", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-i", sources[0], "-protocol_whitelist", "file,pipe", "-f", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-i", sources[1], "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", "-fs", String(YOUTUBE_MAX_MEDIA_BYTES), "-f", "mp4", output], current);
      signal.throwIfAborted();
      if (merge.code || merge.cancelled || merge.timedOut || merge.outputTruncated) throw new YoutubeFailure(`本地音视频合并未完成：${publicValue(merge.stderr.trim().slice(-400)) || `退出码 ${merge.code}`}`);
    }
    output = await containedFile(transaction, path.relative(transaction, output));
    const bytes = (await fs.stat(output)).size;
    if (!bytes || bytes > YOUTUBE_MAX_MEDIA_BYTES) throw new YoutubeFailure("视频为空或超过 2 GiB 上限");
    failureStage = "verification";
    const checked = await probe(output, current, deps, ffprobe);
    signal.throwIfAborted();
    if (!checked?.video || !checked.audio || !Number.isFinite(checked.durationSeconds) || checked.durationSeconds! <= 0) throw new YoutubeFailure("下载文件缺少可核验的视频、音轨或时长");
    const delta = Math.abs(checked.durationSeconds! - duration);
    if (delta > Math.max(0.5, duration * 0.03)) throw new YoutubeFailure("下载视频时长与元数据不符");
    const sha256 = await fileHash(output); signal.throwIfAborted();
    const relative = `media/${reference.nativeId}.mp4`;
    await atomicReplace(output, await writableFile(root, relative));
    content.assets.push({ id: "video/001", role: "video", status: "saved", path: relative, capturePath: relative, bytes, sha256, mime: "video/mp4", partId: reference.nativeId, provenance: "original" });
    content.parts[0].status = "saved";
    content.coverage!.media = "saved: 1 verified MP4 video";
    content.coverage!.duration = `metadata=${duration}s actual=${checked.durationSeconds}s delta=${delta.toFixed(2)}s verified`;
    content.coverage!.formats = `${formats.map(format => format.format_id || format.ext).join("+")}; ${sourceBytes} source bytes; local merge=${sources.length === 2}`;
    await current.onCheckpoint?.(content);
    return content;
  } catch (error) {
    content.coverage!.failureStage = failureStage;
    const reason = context.signal?.aborted ? "下载已取消" : signal.aborted ? "YouTube 采集超时" : publicValue(error instanceof Error ? error.message : "YouTube 采集失败");
    const status = context.signal?.aborted || signal.aborted ? "unavailable" : error instanceof YoutubeFailure ? error.status : "failed";
    if (!content.assets.some(asset => asset.role === "video" && asset.status === "saved")) content.assets.push({ id: "video/001", role: "video", status, reason, provenance: "original" });
    if (content.parts?.[0] && content.parts[0].status !== "saved") { content.parts[0].status = status === "failed" ? "failed" : "unavailable"; content.parts[0].reason = reason; }
    content.coverage!.media = context.signal?.aborted ? "cancelled" : `${status}: ${reason}`;
    content.warnings.push(reason);
    await current.onCheckpoint?.(content);
    return content;
  } finally {
    // Only the unique transaction created by this call may be removed; final or
    // preexisting videos never belong to this cleanup boundary.
    if (transaction && root && isPathWithin(path.join(root, ".youtube-downloads"), transaction) && path.dirname(transaction) === path.join(root, ".youtube-downloads")) await fs.rm(transaction, { recursive: true, force: true }).catch(() => {});
  }
}

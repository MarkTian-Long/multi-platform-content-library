import fs from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import { fetchPublic, fetchedPublicUrl, privateAddress, publicHttpUrl, savePublicAsset } from "./content-network.js";
import { atomicReplace, containedFile, publicValue, writableFile } from "./content-library.js";
import { runContentTool } from "./content-tools.js";
import { DEFAULT_WECHAT_CHANNELS_PARSER } from "./content-settings.js";
import type { CapturedContent, ContentAsset, ContentContext, ContentInput } from "./content-types.js";

export interface WechatChannelsSnapshot {
  finalUrl: string;
  title: string;
  author?: string;
  body: string;
  videos: string[];
  blocked?: "login_required" | "unavailable";
  reason?: string;
}
export interface WechatChannelsDeps {
  /** Explicit opt-in endpoint; no environment or third-party default is consulted. */
  parserEndpoint?: string | null;
  parserCredential?: string;
  parserFetch?: typeof fetchPublic;
  captureWechatChannels?: (input: ContentInput, context: ContentContext) => Promise<WechatChannelsSnapshot>;
  probeMedia?: (file: string, context: ContentContext) => Promise<{ video: boolean; audio?: boolean; durationSeconds?: number } | undefined>;
}

const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_PROFILE_BYTES = 1024 * 1024;
export const WECHAT_CHANNELS_MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const EXCLUDED = "script,style,noscript,nav,footer,aside,[role=complementary],[class*=recommend],[class*=related],[class*=comment],[data-testid*=recommend]";
const textValue = (value: unknown, maximum = 65_536): string => typeof value === "string" ? value.trim().slice(0, maximum) : "";
const titleValue = (value: unknown): string => textValue(value, 240).replace(/\s+/g, " ");
const objectValue = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
function blocked(finalUrl: string, reason: string, status: WechatChannelsSnapshot["blocked"] = "unavailable"): WechatChannelsSnapshot {
  return { finalUrl, title: "", body: "", videos: [], blocked: status, reason };
}

function channelsUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return undefined;
    if (url.hostname === "channels.weixin.qq.com" || (url.hostname === "weixin.qq.com" && /^\/sph\/[a-z0-9]+\/?$/i.test(url.pathname))) return url;
  } catch { /* invalid */ }
  return undefined;
}

/** Static syntactic filtering is followed by publicHttpUrl DNS validation before any request. */
function mediaUrl(value: unknown, base: string, explicitMp4 = false): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > 16_384) return undefined;
  try {
    const url = new URL(value, base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || privateAddress(url.hostname) || /(^|\.)(localhost|local)$/i.test(url.hostname)) return undefined;
    if (/\.(?:m3u8|mpd)(?:$|\?)/i.test(url.pathname) || [...url.searchParams.keys()].some(key => /^(decodekey|decryptkey|encrypted)$/i.test(key))) return undefined;
    if (!explicitMp4 && !/\.mp4$/i.test(url.pathname)) return undefined;
    return url.toString();
  } catch { return undefined; }
}

function encrypted(value: Record<string, unknown> | undefined): boolean {
  return !!value && (value.encrypted === true || value.isEncrypted === true || ["decodeKey", "decode_key", "decryptKey"].some(key => value[key] !== undefined && value[key] !== null && value[key] !== 0 && value[key] !== "0" && value[key] !== ""));
}

/** Only the documented feedInfo record is read; recommendations and arbitrary nested URLs are ignored. */
export function extractWechatChannelsProfile(profile: unknown, finalUrl: string): WechatChannelsSnapshot {
  const envelope = objectValue(profile);
  if (!envelope) return blocked(finalUrl, "解析服务返回的 JSON 格式无效");
  if (envelope.errCode !== undefined && envelope.errCode !== null && envelope.errCode !== 0) return blocked(finalUrl, publicValue(`解析服务错误 ${textValue(String(envelope.errCode), 40)}：${textValue(envelope.errMsg, 400) || "未提供错误说明"}`));
  const data = objectValue(envelope.data), feed = objectValue(data?.feedInfo), author = objectValue(data?.authorInfo);
  if (!feed) return blocked(finalUrl, publicValue(`解析服务未返回 data.feedInfo${textValue(envelope.error, 400) ? `：${textValue(envelope.error, 400)}` : ""}`));
  const h264 = objectValue(feed.h264VideoInfo), h265 = objectValue(feed.h265VideoInfo);
  const candidates = [h264, h265, feed];
  if (encrypted(feed)) return blocked(finalUrl, "解析服务返回加密视频；当前适配器不执行媒体解密");
  let selected: string | undefined;
  for (const candidate of candidates) {
    if (encrypted(candidate)) continue;
    selected = mediaUrl(candidate?.videoUrl, finalUrl, true);
    if (selected) break;
  }
  if (!selected) return blocked(finalUrl, candidates.some(encrypted) ? "解析服务返回加密视频；当前适配器不执行媒体解密" : "解析服务未返回可下载的 HTTP(S) 视频地址");
  const body = textValue(feed.description);
  return { finalUrl, title: titleValue(feed.title) || titleValue(body), author: titleValue(author?.nickname) || undefined, body, videos: [selected] };
}

/** Contract of the anonymous resolver; only its exact configured endpoint selects this schema. */
export function extractWechatChannelsResolverProfile(profile: unknown, finalUrl: string): WechatChannelsSnapshot {
  const envelope = objectValue(profile);
  if (!envelope || envelope.ok !== true) return blocked(finalUrl, publicValue(`解析服务未成功解析分享链接：${textValue(envelope?.error, 400) || "返回状态无效"}`));
  const data = objectValue(envelope.data);
  if (!data) return blocked(finalUrl, "解析服务未返回有效的视频信息");
  if (encrypted(data)) return blocked(finalUrl, "解析服务返回加密视频；当前适配器不执行媒体解密");
  const selected = mediaUrl(data.h264_url, finalUrl, true) || mediaUrl(data.h265_url, finalUrl, true);
  if (!selected) return blocked(finalUrl, "解析服务未返回可下载的 HTTP(S) 视频地址");
  const body = textValue(data.description);
  return { finalUrl, title: titleValue(data.title) || titleValue(body), author: titleValue(data.author) || undefined, body, videos: [selected] };
}

/** Parses HTML without executing scripts. At most one foreground video or page-scoped MP4 is accepted. */
export function extractWechatChannelsHtml(html: string, finalUrl: string): WechatChannelsSnapshot {
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) return blocked(finalUrl, "分享页正文超过解析上限");
  if (!channelsUrl(finalUrl)) return blocked(finalUrl, "分享链接未跳转到微信视频号页面");
  const $ = load(html);
  const meta = (name: string) => textValue($(`meta[property="${name}"],meta[name="${name}"]`).first().attr("content"));
  const identity = meta("og:url") || $("link[rel=canonical]").first().attr("href");
  if (identity) {
    const page = channelsUrl(finalUrl);
    let declared: URL | undefined;
    try { declared = channelsUrl(new URL(identity, finalUrl).toString()); } catch { /* untrusted malformed metadata */ }
    if (!declared || declared.origin !== page?.origin || declared.pathname !== page.pathname || ["eid", "exportid", "id"].some(key => declared.searchParams.has(key) && declared.searchParams.get(key) !== page.searchParams.get(key))) return blocked(finalUrl, "页面元数据不属于当前视频号分享链接");
  }
  const metadataVideo = mediaUrl(meta("og:video:secure_url") || meta("og:video:url") || meta("og:video"), finalUrl, /^video\/mp4$/i.test(meta("og:video:type")));
  $(EXCLUDED).remove();
  const roots = $("main,article,[role=main],#feed-detail,.feed-detail,#finder-feed,.finder-feed,[data-feed-id]");
  const candidates = roots.filter((_, node) => !roots.toArray().some(other => other !== node && $(node).find(other).length > 0));
  if (candidates.length > 1) return blocked(finalUrl, "页面包含多个内容主体，无法确认当前分享的视频");
  const root = candidates.length === 1 ? candidates.first() : undefined;
  const foreground = root?.find("video");
  if (foreground && foreground.length > 1) return blocked(finalUrl, "页面包含多个视频主体，无法确认当前分享的视频");
  if (foreground?.length && ["data-decode-key", "data-decrypt-key", "decodekey"].some(name => /[^0\s]/.test(foreground.attr(name) || ""))) return blocked(finalUrl, "页面提供的是加密视频；当前适配器不执行媒体解密");
  const elementVideo = foreground?.length ? mediaUrl(foreground.attr("src"), finalUrl) || foreground.find("source").toArray().map(node => mediaUrl($(node).attr("src"), finalUrl, /^video\/mp4$/i.test($(node).attr("type") ?? ""))).find(Boolean) : undefined;
  const selected = elementVideo || metadataVideo;
  const visible = $("body").text().replace(/\s+/g, " ").trim();
  if (!selected) {
    if (/扫码登录|扫描二维码|请(?:使用|用)微信扫码|请(?:先)?登录|安全验证|人机验证|完成验证|滑块验证/.test(visible)) return blocked(finalUrl, "分享页要求微信扫码、登录或验证", "login_required");
    if (/在微信(?:客户端|中|内)打开|微信客户端|打开微信|微信扫一扫/.test(visible)) return blocked(finalUrl, "分享页只能在微信客户端打开，未提供可下载的公开视频流");
    return blocked(finalUrl, "分享页未提供可下载的 MP4 视频；可能需要微信客户端或有效解析服务");
  }
  return { finalUrl, title: titleValue(root?.find("h1,.title").first().text()) || titleValue(meta("og:title")) || titleValue($("title").text()), author: titleValue(root?.find(".author,[data-testid=author]").first().text()) || titleValue(meta("author")) || undefined, body: textValue(root?.find(".description,.desc,[data-testid=description]").first().text()) || meta("og:description"), videos: [selected] };
}

async function boundedText(response: Response, signal: AbortSignal | undefined, maximum: number): Promise<string> {
  const announced = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(announced) && announced > maximum) { await response.body?.cancel().catch(() => {}); throw new Error("响应正文超过保存上限"); }
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason;
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength; if (bytes > maximum) throw new Error("响应正文超过保存上限"); chunks.push(chunk.value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } finally { await reader.cancel().catch(() => {}); }
}

async function capture(input: ContentInput, context: ContentContext, deps: WechatChannelsDeps): Promise<WechatChannelsSnapshot> {
  const anonymousResolver = !!deps.parserEndpoint && new URL(deps.parserEndpoint).href === DEFAULT_WECHAT_CHANNELS_PARSER;
  const signal = AbortSignal.any([AbortSignal.timeout(anonymousResolver ? 90_000 : 45_000), ...(context.signal ? [context.signal] : [])]);
  if (deps.parserEndpoint) {
    const parser = await publicHttpUrl(deps.parserEndpoint, signal);
    if (parser.protocol !== "https:" || parser.search || parser.hash) throw new Error("视频号解析服务必须使用无凭据参数的 HTTPS 地址");
    const share = channelsUrl(input.url);
    if (!share || share.hostname !== "weixin.qq.com" || share.protocol !== "https:") return blocked(input.url, "此解析服务仅支持 weixin.qq.com/sph/ 分享短链");
    share.search = ""; share.hash = "";
    context.onProgress?.("正在向已启用的解析服务提交视频号分享链接（仅链接）");
    const headers: Record<string,string> = { Accept: "application/json", "Content-Type": "application/json" };
    if (!anonymousResolver && deps.parserCredential) headers.Authorization = `Bearer ${deps.parserCredential}`;
    const response = await (deps.parserFetch ?? fetchPublic)(parser, { method: "POST", redirect: "error", credentials: "omit", headers, body: JSON.stringify({ url: share.toString() }) }, signal);
    let profile: unknown;
    try { profile = JSON.parse(await boundedText(response, signal, MAX_PROFILE_BYTES)); }
    catch (error) { if (error instanceof SyntaxError) throw new Error(`视频号解析服务返回非 JSON 响应（HTTP ${response.status}）`); throw error; }
    if (!anonymousResolver && (response.status === 401 || response.status === 403)) throw new Error(`视频号解析服务 HTTP ${response.status}：需要有效的服务访问凭证，请在本地配置；无需提供微信 Cookie`);
    if (!response.ok) throw new Error(publicValue(`视频号解析服务 HTTP ${response.status}：${textValue(objectValue(profile)?.errMsg, 400) || textValue(objectValue(profile)?.error, 400) || "解析请求失败"}`));
    return anonymousResolver ? extractWechatChannelsResolverProfile(profile, input.url) : extractWechatChannelsProfile(profile, input.url);
  }
  context.onProgress?.("正在获取微信视频号公开分享页");
  const response = await fetchPublic(input.url, { credentials: "omit", headers: { Accept: "text/html,application/xhtml+xml" } }, signal);
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`视频号分享页 HTTP ${response.status}`); }
  const finalUrl = fetchedPublicUrl(response) || input.url;
  return extractWechatChannelsHtml(await boundedText(response, signal, MAX_HTML_BYTES), finalUrl);
}

async function probeVideo(file: string, context: ContentContext): Promise<{ video: boolean; audio?: boolean } | undefined> {
  const names = process.platform === "win32" ? ["ffprobe.exe", "ffprobe"] : ["ffprobe"];
  const folders = [path.join(context.runtimeRoot, "tools"), ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean)];
  let command: string | undefined;
  for (const folder of folders) {
    for (const name of names) { const candidate = path.join(folder, name); if (await fs.stat(candidate).then(stat => stat.isFile(), () => false)) { command = candidate; break; } }
    if (command) break;
  }
  if (!command) return undefined;
  const result = await runContentTool({ command, args: ["-protocol_whitelist", "file,pipe", "-v", "error", "-show_entries", "stream=codec_type:format=format_name", "-of", "json", file], cwd: context.directory, signal: context.signal, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
  if (result.code !== 0 || result.outputTruncated) return { video: false };
  try {
    const parsed = JSON.parse(result.stdout) as { streams?: Array<{ codec_type?: string }>; format?: { format_name?: string } };
    return { video: /\b(?:mp4|mov)\b/.test(parsed.format?.format_name ?? "") && !!parsed.streams?.some(stream => stream.codec_type === "video"), audio: !!parsed.streams?.some(stream => stream.codec_type === "audio") };
  } catch { return { video: false }; }
}

export async function acquireWechatChannels(input: ContentInput, context: ContentContext, deps: WechatChannelsDeps = {}): Promise<CapturedContent> {
  if (context.signal?.aborted) throw new DOMException("已取消", "AbortError");
  const content: CapturedContent = { platform: "wechat_channels", nativeId: input.nativeId, sourceUrl: input.url, canonicalUrl: input.canonicalUrl, title: "微信视频号", capturedAt: new Date().toISOString(), kind: "video", markdown: "", assets: [], warnings: [], coverage: {} };
  const checkpoint = () => context.onCheckpoint?.(content);
  const unavailable = async (status: ContentAsset["status"], reason: string) => {
    const safeReason=publicValue(deps.parserCredential?reason.split(deps.parserCredential).join("[已隐藏]"):reason);
    content.assets.push({ id: "video/001", role: "video", status, reason: safeReason, provenance: "original" });
    content.coverage!.media = status; content.warnings.push(safeReason); await checkpoint(); return content;
  };
  try {
    if (!channelsUrl(input.url)) throw new Error("只接受微信视频号分享链接");
    await publicHttpUrl(input.url, context.signal);
    await fs.mkdir(context.directory, { recursive: true });
    const snapshot = deps.captureWechatChannels ? await deps.captureWechatChannels(input, context) : await capture(input, context, deps);
    await publicHttpUrl(snapshot.finalUrl, context.signal);
    if (!channelsUrl(snapshot.finalUrl)) return unavailable("unavailable", "分享链接未跳转到微信视频号页面");
    content.title = titleValue(snapshot.title) || content.title;
    if (snapshot.blocked) return unavailable(snapshot.blocked, snapshot.reason || "未取得可下载的视频");
    const urls = [...new Set(snapshot.videos.map(value => mediaUrl(value, snapshot.finalUrl, true)).filter((value): value is string => !!value))];
    if (urls.length !== 1) return unavailable("unavailable", urls.length ? "返回多个视频主体，无法确认当前分享的视频" : "分享页或解析服务未提供可下载的公开视频流");
    content.author = titleValue(snapshot.author) || undefined; content.markdown = textValue(snapshot.body); content.coverage!.body = content.markdown ? "saved: original description" : "unavailable: description empty";
    await checkpoint();
    const asset = await savePublicAsset(urls[0], context.directory, "video/001", "video", context.signal, WECHAT_CHANNELS_MAX_VIDEO_BYTES, context.existing?.assets.find(item => item.id === "video/001"));
    if (asset.status === "saved" && asset.path) {
      const file = await containedFile(context.directory, asset.path);
      const probe = await (deps.probeMedia ?? probeVideo)(file, context);
      if (!probe) { asset.status = "unavailable"; asset.reason = "下载文件未验证视频流；请检查 ffprobe 是否可用"; }
      else if (!probe.video) { asset.status = "unavailable"; asset.reason = "下载文件没有可验证的 MP4 视频流，可能是加密媒体或无效响应"; }
      else if (!asset.path.endsWith(".mp4")) { const relative = "video/001.mp4"; await atomicReplace(file, await writableFile(context.directory, relative)); asset.path = relative; asset.mime = "video/mp4"; }
    }
    content.assets.push(asset);
    content.coverage!.media = asset.status === "saved" ? "saved: 1 verified MP4 video" : `${asset.status}: ${asset.reason || "未取得有效视频流"}`;
    if (asset.status !== "saved") content.warnings.push(publicValue(asset.reason || "视频未保存成功"));
    await checkpoint(); return content;
  } catch (error) {
    if (context.signal?.aborted) throw new DOMException("已取消", "AbortError");
    return unavailable("failed", publicValue(error instanceof Error ? error.message : "视频号采集失败"));
  }
}

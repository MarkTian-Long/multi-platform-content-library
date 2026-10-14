import type { CapturedContent, ContentContext, ContentInput } from "./content-types.js";
import type { ContentToolRunResult } from "./content-tools.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { load } from "cheerio";
import { douyinWorkReference } from "./content-social-reference.js";
import { fetchPublic, fetchedPublicUrl, publicHttpUrl, savePublicAsset } from "./content-network.js";
import { atomicReplace, containedFile, ensureDirectory, fileHash, publicValue, writableFile } from "./content-library.js";
import { runContentTool } from "./content-tools.js";
import { isPathWithin } from "./url-policy.js";
import { captureSocialBrowser, SocialBrowserError, socialBrowserJsonEndpoint, type SocialBrowserSnapshot } from "./content-social-browser.js";
import type { PhotoMedia, PhotoMediaDeps } from "./content-photo-media.js";

export interface DouyinDeps extends PhotoMediaDeps {
  ytDlpPath?: string;
  runTool?: (command: string, args: string[], context: ContentContext) => Promise<ContentToolRunResult>;
  probeMedia?: (file: string, context: ContentContext) => Promise<{ video: boolean; audio: boolean; durationSeconds?: number } | undefined>;
  maxVideoBytes?: number;
  maxDurationSeconds?: number;
  captureBrowser?: typeof captureSocialBrowser;
}

export const DOUYIN_MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PAGE_BYTES = 6 * 1024 * 1024;
type Snapshot = { id: string; title?: string; description: string; author?: string; duration?: number; videoUrl?: string; images: boolean; photos?: PhotoMedia[]; publishedAt?: string };
class DouyinFailure extends Error { constructor(message: string, readonly status: "failed" | "unavailable" | "login_required" | "missing_dependency" = "failed") { super(message); } }

function address(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.toString() : undefined; } catch { return undefined; }
}
function firstAddress(value: unknown): string | undefined { return Array.isArray(value) ? value.map(address).find(Boolean) : undefined; }

function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function addresses(value: unknown): string[] { return Array.isArray(value) ? [...new Set(value.slice(0, 32).map(address).filter((value): value is string => !!value))] : []; }
function durationSeconds(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value / 1000 : undefined; }
function exactDeclaredWork(value: Record<string, unknown>, expectedId: string): void {
  for (const key of ["aweme_id", "awemeId"]) if (value[key] !== undefined && value[key] !== null && value[key] !== expectedId) throw new DouyinFailure("作品或照片声明的抖音作品身份不匹配，未采集", "unavailable");
}

/** The official detail's ordered images array owns both members of each photo pair. */
function rawPhotos(value: unknown[], expectedId: string): PhotoMedia[] {
  if (value.length > 500) throw new DouyinFailure("图集照片数量超过读取上限，未采集", "unavailable");
  return value.map((value, offset) => {
    const image = record(value); const video = record(image?.video);
    if (image) exactDeclaredWork(image, expectedId);
    if (video) exactDeclaredWork(video, expectedId);
    const imageUrls = addresses(image?.url_list);
    const protectedMotion = !!video && ["has_drm", "is_drm", "drm"].some(key => !!video[key]);
    const motionUrls = protectedMotion ? [] : [...new Set(["play_addr_h264", "play_addr", "download_addr"].flatMap(key => addresses(record(video?.[key])?.url_list)))];
    const motionExpected = !!motionUrls.length || !!video && Object.keys(video).length > 0 || image?.live_photo_type !== undefined && image.live_photo_type !== null && image.live_photo_type !== 0 && image.live_photo_type !== "0" || image?.clip_type === 5 || image?.clip_type === "5";
    const reason = protectedMotion ? "该照片动态原视频受保护，未执行解密或采集" : !image ? "该序号的原照片数据缺失或格式未知" : undefined;
    // uri identifies the original image resource; renderer image_id fields use a different namespace.
    const uri = typeof image?.uri === "string" ? image.uri.trim() : "";
    return { id: uri ? `uri:${uri}` : `photo-${String(offset + 1).padStart(3, "0")}`, index: offset + 1, imageUrls, motionUrls, motionExpected, ...(durationSeconds(video?.duration) ? { durationSeconds: durationSeconds(video?.duration) } : {}), ...(reason ? { reason } : {}) };
  });
}

function rawWork(value: unknown, expectedId: string): Snapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, any>;
  if (typeof item.aweme_id !== "string" || item.aweme_id !== expectedId) return undefined;
  exactDeclaredWork(item, expectedId);
  const gallery = Array.isArray(item.images) && item.images.length > 0 || [2, 68].includes(item.aweme_type);
  if (item.is_live || item.live_room || !gallery && item.video?.has_drm) throw new DouyinFailure("直播或受保护作品不在单条视频保存范围", "unavailable");
  // A photo post's top-level video is a slideshow/BGM record, not a motion-photo member.
  const video = gallery ? undefined : item.video;
  const videoUrl = firstAddress(video?.play_addr_h264?.url_list) || firstAddress(video?.play_addr?.url_list) || firstAddress(video?.download_addr?.url_list);
  const duration = typeof video?.duration === "number" && Number.isFinite(video.duration) && video.duration > 0 ? video.duration / 1000 : undefined;
  const timestamp = typeof item.create_time === "number" && Number.isFinite(item.create_time) && item.create_time > 0 ? new Date(item.create_time * 1000) : undefined;
  const photos = Array.isArray(item.images) ? rawPhotos(item.images, expectedId) : undefined;
  const images = !!photos?.length || [2, 68].includes(item.aweme_type);
  return { id: expectedId, description: typeof item.desc === "string" ? item.desc.trim() : "", author: typeof item.author?.nickname === "string" ? item.author.nickname.trim().slice(0, 240) : undefined, duration, videoUrl, images, ...(photos ? { photos } : {}), publishedAt: timestamp && Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined };
}

function stateCandidates(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  const state = value as Record<string, any>;
  const candidates: unknown[] = [state.aweme_detail, state.aweme?.detail, state.awemeDetail];
  for (const key of ["video_(id)/page", "note_(id)/page"]) {
    const slot = state.loaderData?.[key];
    if (Array.isArray(slot?.videoInfoRes?.item_list)) candidates.push(...slot.videoInfoRes.item_list);
    if (slot?.aweme_detail) candidates.push(slot.aweme_detail);
  }
  return candidates;
}

function routerObject(html: string): unknown {
  const marker = /(?:window\.)?_ROUTER_DATA\s*=\s*/.exec(html);
  if (!marker) return undefined;
  const start = marker.index + marker[0].length;
  if (html[start] !== "{") return undefined;
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < html.length; index++) {
    const character = html[index];
    if (quoted) { if (escaped) escaped = false; else if (character === "\\") escaped = true; else if (character === '"') quoted = false; }
    else if (character === '"') quoted = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) { try { return JSON.parse(html.slice(start, index + 1)); } catch { return undefined; } }
  }
  return undefined;
}

/** Parse only known current-work slots; never scan recommendations or execute page scripts. */
export function extractDouyinWork(html: string, expectedId: string): Snapshot | undefined {
  const states: unknown[] = [routerObject(html)];
  const embedded = load(html)("script#RENDER_DATA").text().trim();
  if (embedded) { try { states.push(JSON.parse(embedded.startsWith("%") ? decodeURIComponent(embedded) : embedded)); } catch { /* malformed state cannot supply an identity */ } }
  const matches = states.flatMap(stateCandidates).map(item => rawWork(item, expectedId)).filter((item): item is Snapshot => !!item);
  const unique = new Map(matches.map(snapshot => [JSON.stringify(snapshot), snapshot]));
  if (unique.size > 1) throw new DouyinFailure("当前作品身份对应多个不一致主体，未采集");
  return unique.values().next().value;
}

function completeVideo(snapshot: Snapshot | undefined): boolean { return !!snapshot?.videoUrl && !!snapshot.duration; }
const photoIdentityConflict = (photo: PhotoMedia): boolean => /资源身份.*不一致/.test(photo.reason ?? "");
function completePhotos(snapshot: Snapshot | undefined): boolean { return !!snapshot?.images && !!snapshot.photos?.length && snapshot.photos.every(photo => !photoIdentityConflict(photo) && !!photo.imageUrls.length && (!photo.motionExpected || !!photo.motionUrls.length)); }

function enrichPhotos(previous: PhotoMedia[] | undefined, next: PhotoMedia[] | undefined): PhotoMedia[] | undefined {
  if (!previous?.length) return next ?? previous;
  if (!next?.length) return previous;
  const count = Math.max(previous.length, next.length);
  return Array.from({ length: count }, (_, offset) => {
    const before = previous[offset], after = next[offset];
    if (!before && after) return after;
    if (!after && before) return before;
    if (!before || !after) throw new DouyinFailure("图集照片序号缺失，未采集", "unavailable");
    if (before.index !== after.index) throw new DouyinFailure("图集照片原序号不匹配，未采集", "unavailable");
    const beforeUri = before.id.startsWith("uri:"), afterUri = after.id.startsWith("uri:");
    if (beforeUri && afterUri && before.id !== after.id) {
      return { ...before, motionExpected: before.motionExpected || after.motionExpected, reason: `第${before.index}张原照片资源身份与补充来源不一致，已保留此前原图，未混用动态` };
    }
    const id = afterUri ? after.id : before.id;
    const protectedReason = [before.reason, after.reason].find(reason => /受保护|加密/.test(reason ?? ""));
    return { ...before, ...after, id, imageUrls: [...new Set([...after.imageUrls, ...before.imageUrls])], motionUrls: protectedReason ? [] : [...new Set([...after.motionUrls, ...before.motionUrls])], motionExpected: before.motionExpected || after.motionExpected, durationSeconds: after.durationSeconds ?? before.durationSeconds, reason: protectedReason ?? after.reason };
  });
}

/** Only missing fields are enriched; an exact original description is never erased. */
function enrichSnapshot(previous: Snapshot | undefined, next: Snapshot): Snapshot {
  if (!previous) return next;
  return { ...previous, title: previous.title || next.title, description: previous.description || next.description, author: previous.author || next.author, publishedAt: previous.publishedAt || next.publishedAt, duration: next.duration || previous.duration, videoUrl: next.videoUrl || previous.videoUrl, images: previous.images || next.images, photos: enrichPhotos(previous.photos, next.photos) };
}

function browserWork(browser: SocialBrowserSnapshot, expectedId: string): Snapshot | undefined {
  let final: URL;
  try { final = new URL(browser.finalUrl); } catch { throw new DouyinFailure("Edge 目标页面地址无效", "unavailable"); }
  if (!["http:", "https:"].includes(final.protocol) || final.username || final.password || final.port || !["douyin.com", "www.douyin.com", "iesdouyin.com", "www.iesdouyin.com"].includes(final.hostname)) throw new DouyinFailure("Edge 未停留在抖音官方目标页面", "unavailable");
  const reference = douyinWorkReference(browser.finalUrl);
  if (reference && reference.nativeId !== expectedId) throw new DouyinFailure("Edge 页面作品身份不匹配", "unavailable");
  let selected = extractDouyinWork(browser.html, expectedId);
  for (const response of browser.responses) {
    if (!socialBrowserJsonEndpoint("douyin", response.url)) continue;
    const requestIds = new URL(response.url).searchParams.getAll("aweme_id");
    if (requestIds.length > 1 || requestIds.length === 1 && requestIds[0] !== expectedId) continue;
    if (!response.data || typeof response.data !== "object" || Array.isArray(response.data)) continue;
    const data = response.data as Record<string, unknown>;
    if (data.status_code !== undefined && data.status_code !== 0) continue;
    const candidate = rawWork(data.aweme_detail, expectedId);
    if (candidate) selected = enrichSnapshot(selected, candidate);
  }
  return selected;
}

async function cookies(runtimeRoot: string, requestPath: string): Promise<{ file?: string; header?: string }> {
  const profile = path.join(runtimeRoot, ".content-profile", "douyin");
  const candidate = path.join(profile, "cookies.txt");
  const stat = await fs.lstat(candidate).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!stat || !stat.size) return {};
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new DouyinFailure("抖音专用会话文件不安全");
  const file = await containedFile(profile, "cookies.txt");
  const now = Date.now() / 1000; const entries: string[] = [];
  for (let line of (await fs.readFile(file, "utf8")).split(/\r?\n/)) {
    line = line.replace(/^#HttpOnly_/, ""); if (line.startsWith("#")) continue;
    const [domain, subdomains, cookiePath, _secure, expiry, name, value] = line.split("\t");
    const normalized = domain?.replace(/^\./, "");
    const domainMatches = normalized === "www.douyin.com" || normalized === "douyin.com" && subdomains === "TRUE";
    const pathMatches = cookiePath && (requestPath === cookiePath || requestPath.startsWith(cookiePath) && (cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/"));
    if (!domainMatches || !pathMatches || !Number.isFinite(Number(expiry)) || Number(expiry) && Number(expiry) <= now || !/^[-_A-Za-z0-9]+$/.test(name ?? "") || !value || /[\x00-\x20\x7f;,]/.test(value)) continue;
    entries.push(`${name}=${value}`);
  }
  return { file, header: entries.length ? entries.join("; ") : undefined };
}

async function executable(runtimeRoot: string, name: string, configured?: string): Promise<string | undefined> {
  const names = process.platform === "win32" ? [`${name}.exe`, name] : [name];
  const candidates = [configured, ...names.map(file => path.join(runtimeRoot, "tools", file)), ...(process.env.PATH ?? "").split(path.delimiter).flatMap(folder => names.map(file => path.join(folder, file)))];
  for (const candidate of candidates) if (candidate && await fs.stat(candidate).then(stat => stat.isFile(), () => false)) return candidate;
  return undefined;
}

async function readPage(response: Response, signal: AbortSignal): Promise<string> {
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (announced > MAX_PAGE_BYTES || !response.body) { await response.body?.cancel().catch(() => {}); throw new DouyinFailure("抖音作品页超过读取上限或无正文"); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) { const chunk = await reader.read(); signal.throwIfAborted(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > MAX_PAGE_BYTES) throw new DouyinFailure("抖音作品页超过读取上限"); chunks.push(chunk.value); }
    return Buffer.concat(chunks).toString("utf8");
  } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** The anonymously readable official gallery endpoint returns only the submitted work. */
async function slidesMetadata(expectedId: string, context: ContentContext): Promise<Snapshot | undefined> {
  const signal = AbortSignal.any([context.signal!, AbortSignal.timeout(45000)]);
  const endpoint = new URL("https://www.iesdouyin.com/web/api/v2/aweme/slidesinfo/");
  // The official API takes JSON numeric IDs; the reference already validates decimal digits.
  // Construct the JSON text directly so a 19-digit ID never passes through a lossy Number.
  endpoint.searchParams.set("aweme_ids", `[${expectedId}]`); endpoint.searchParams.set("request_source", "200");
  context.onProgress?.("正在读取抖音官方图集原件列表");
  const response = await fetchPublic(endpoint, { method: "GET", redirect: "error", credentials: "omit", headers: { Accept: "application/json" } }, signal);
  if (!response.ok) { await response.body?.cancel().catch(() => {}); return undefined; }
  let data: Record<string, unknown> | undefined;
  try { data = record(JSON.parse(await readPage(response, signal))); }
  catch (error) { signal.throwIfAborted(); if (error instanceof SyntaxError) return undefined; throw error; }
  if (data?.status_code !== 0 || !Array.isArray(data.aweme_details)) return undefined;
  const matches: Snapshot[] = [];
  for (const value of data.aweme_details) {
    const item = record(value);
    if (!item || item.aweme_id !== expectedId) throw new DouyinFailure("抖音图集接口返回的作品身份不匹配，未采集", "unavailable");
    const snapshot = rawWork(item, expectedId);
    if (snapshot) matches.push(snapshot);
  }
  const unique = new Map(matches.map(snapshot => [JSON.stringify(snapshot), snapshot]));
  if (unique.size > 1) throw new DouyinFailure("抖音图集接口返回多个不一致主体，未采集", "unavailable");
  return unique.values().next().value;
}

async function metadata(reference: { nativeId: string; canonicalUrl: string }, context: ContentContext, deps: DouyinDeps, cookieFile?: string): Promise<Snapshot> {
  const command = await executable(context.runtimeRoot, "yt-dlp", deps.ytDlpPath ?? process.env.CONTENT_YTDLP_PATH);
  if (!command) throw new DouyinFailure("当前作品页没有直链，且未找到 yt-dlp", "missing_dependency");
  const signal = AbortSignal.any([context.signal!, AbortSignal.timeout(60000)]); const current = { ...context, signal };
  const args = ["--ignore-config", "--no-config-locations", "--no-plugin-dirs", "--no-remote-components", "--use-extractors", "^Douyin$", "--no-playlist", "--no-check-formats", "--skip-download", "--socket-timeout", "15", "--retries", "2", "--extractor-retries", "1", ...(cookieFile ? ["--cookies", cookieFile] : []), "--dump-single-json", "--", reference.canonicalUrl];
  const result = await (deps.runTool ?? ((command, args, current) => runContentTool({ command, args, cwd: current.directory, signal: current.signal, timeoutMs: 60000, maxOutputBytes: 2 * 1024 * 1024 })))(command, args, current);
  if (signal.aborted || result.cancelled || result.timedOut) throw new DouyinFailure(context.signal?.aborted ? "抖音采集已取消" : "抖音元数据读取超时", "unavailable");
  if (result.code || result.outputTruncated) {
    if (/fresh cookies|login|sign.?in|captcha|verification|验证码|验证/i.test(result.stderr)) throw new DouyinFailure("该作品需要有效站点会话或验证；请在应用专用窗口完成后重试", "login_required");
    throw new DouyinFailure(result.outputTruncated ? "抖音元数据超过读取上限" : "抖音元数据无法取得，未下载媒体", "unavailable");
  }
  let info: Record<string, any>; try { info = JSON.parse(result.stdout); } catch { throw new DouyinFailure("抖音元数据无效"); }
  if (!info || Array.isArray(info) || info.id !== reference.nativeId || info.extractor_key !== "Douyin" || info.entries !== undefined || info._type && info._type !== "video") throw new DouyinFailure("抖音元数据作品身份不匹配");
  if (typeof info.webpage_url === "string" && douyinWorkReference(info.webpage_url)?.nativeId !== reference.nativeId) throw new DouyinFailure("抖音元数据页面身份不匹配");
  if (info.is_live || info.live_status === "is_live" || info.has_drm) throw new DouyinFailure("直播或受保护作品不可保存", "unavailable");
  const formats = Array.isArray(info.formats) ? info.formats.filter((format: any) => format && format.ext === "mp4" && format.vcodec !== "none" && !format.has_drm && !format.fragments?.length && ["http", "https"].includes(format.protocol) && address(format.url)) : [];
  formats.sort((a: any, b: any) => (Number(b.height) || 0) - (Number(a.height) || 0) || (Number(b.tbr) || 0) - (Number(a.tbr) || 0));
  const format = formats[0]; if (!format) throw new DouyinFailure("未取得可安全下载的抖音 MP4 原视频", "unavailable");
  if (Number(format.filesize) > (deps.maxVideoBytes ?? DOUYIN_MAX_VIDEO_BYTES)) throw new DouyinFailure("视频超过保存上限", "unavailable");
  return { id: reference.nativeId, title: typeof info.title === "string" ? info.title : undefined, description: typeof info.description === "string" ? info.description.trim() : "", author: typeof info.uploader === "string" ? info.uploader.slice(0, 240) : undefined, duration: typeof info.duration === "number" && Number.isFinite(info.duration) && info.duration > 0 ? info.duration : undefined, videoUrl: address(format.url), images: false };
}

async function probe(file: string, context: ContentContext, deps: DouyinDeps): Promise<{ video: boolean; audio: boolean; durationSeconds?: number } | undefined> {
  if (deps.probeMedia) return deps.probeMedia(file, context);
  const command = await executable(context.runtimeRoot, "ffprobe", process.env.CONTENT_FFPROBE_PATH); if (!command) return undefined;
  const current = { ...context, signal: AbortSignal.any([context.signal!, AbortSignal.timeout(30000)]) };
  const args = ["-protocol_whitelist", "file,pipe", "-f", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", file];
  const result = await (deps.runTool ?? ((command, args, current) => runContentTool({ command, args, cwd: current.directory, signal: current.signal, timeoutMs: 30000 })))(command, args, current);
  if (result.code || result.timedOut || result.cancelled || result.outputTruncated) return undefined;
  try { const info = JSON.parse(result.stdout); return { video: info.streams?.some((stream: any) => stream.codec_type === "video") === true, audio: info.streams?.some((stream: any) => stream.codec_type === "audio") === true, durationSeconds: Number(info.format?.duration) }; } catch { return undefined; }
}

/** Save exactly one work, preserving source bytes and rejecting unverified media. */
export async function acquireDouyin(input: ContentInput, context: ContentContext, deps: DouyinDeps = {}): Promise<CapturedContent> {
  const content: CapturedContent = { platform: input.platform, nativeId: input.nativeId, sourceUrl: input.url, canonicalUrl: input.canonicalUrl, title: "抖音作品", kind: "video", capturedAt: new Date().toISOString(), markdown: "", assets: [], warnings: [], coverage: { media: "not_attempted", comments: "not_supported: native Douyin comments", subtitles: "not_supported: native Douyin subtitles" } };
  const signal = AbortSignal.any([AbortSignal.timeout(10 * 60000), ...(context.signal ? [context.signal] : [])]); const current = { ...context, signal };
  let transaction: string | undefined; let root: string | undefined;
  try {
    signal.throwIfAborted();
    const reference = douyinWorkReference(input.url);
    if (input.platform !== "douyin" || !reference || input.nativeId && input.nativeId !== reference.nativeId) throw new DouyinFailure("仅接受身份明确的抖音单条作品链接", "unavailable");
    content.nativeId = reference.nativeId; content.canonicalUrl = reference.canonicalUrl; if (reference.kind === "note") content.kind = "gallery";
    const maximum = Math.min(deps.maxVideoBytes ?? DOUYIN_MAX_VIDEO_BYTES, DOUYIN_MAX_VIDEO_BYTES);
    if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new DouyinFailure("视频保存预算无效");
    await publicHttpUrl(reference.canonicalUrl, signal);
    await ensureDirectory(context.directory); root = await fs.realpath(context.directory);
    const session = await cookies(context.runtimeRoot, new URL(reference.canonicalUrl).pathname);
    let snapshot: Snapshot | undefined;
    let httpError: unknown;
    const retainBody = () => {
      if (!snapshot) return;
      content.markdown = snapshot.description; content.author = snapshot.author; content.publishedAt = snapshot.publishedAt;
      if (snapshot.images) content.kind = "gallery";
      for (const photo of snapshot.photos ?? []) if (photoIdentityConflict(photo) && photo.reason && !content.warnings.includes(photo.reason)) content.warnings.push(photo.reason);
      content.title = (snapshot.title || snapshot.description).replace(/\s+/g, " ").trim().slice(0, 160) || content.title;
      content.coverage!.body = content.markdown ? "saved: exact-work original description" : "unavailable: no original description";
    };
    try {
      const pageSignal = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
      const response = await fetchPublic(reference.canonicalUrl, { headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0", ...(session.header ? { cookie: session.header } : {}) } }, pageSignal);
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new DouyinFailure([401, 403, 412].includes(response.status) ? "作品页要求有效会话或验证" : `作品页 HTTP ${response.status}`, [401, 403, 412].includes(response.status) ? "login_required" : "unavailable"); }
      const finalUrl = fetchedPublicUrl(response) || reference.canonicalUrl;
      const finalReference = douyinWorkReference(finalUrl);
      if (!finalReference || finalReference.nativeId !== reference.nativeId) { await response.body?.cancel().catch(() => {}); throw new DouyinFailure("作品页跳转身份不匹配，未采集", /login|verify|captcha/i.test(finalUrl) ? "login_required" : "unavailable"); }
      const html = await readPage(response, pageSignal);
      snapshot = extractDouyinWork(html, reference.nativeId); retainBody();
      const visible = load(html); visible("script,style,noscript").remove();
      const challengeElement = visible("[id*=captcha],iframe[src*=captcha]").length > 0;
      const verificationText = /滑块验证码|请完成.{0,8}验证|请拖动.{0,8}滑块/i.test(visible("body").text()) || /^(?:抖音[\s_-]*)?(?:登录|安全验证|验证中心|verify|captcha)(?:[\s_|—-]|$)/i.test(visible("title").text().trim());
      if (challengeElement || !snapshot && verificationText) throw new DouyinFailure("作品页要求验证；请在应用专用窗口人工完成", "login_required");
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && /私网|不能包含账号|不允许访问本机|多个不一致主体|声明的抖音作品身份|图集照片数量超过/.test(error.message)) throw error;
      httpError = error;
    }
    if ((reference.kind === "note" || snapshot?.images) && !completePhotos(snapshot)) {
      signal.throwIfAborted();
      try {
        const exact = await slidesMetadata(reference.nativeId, current);
        if (exact) { snapshot = enrichSnapshot(snapshot, exact); retainBody(); if (completePhotos(snapshot)) httpError = undefined; }
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof Error && /私网|不能包含账号|不允许访问本机|作品身份不匹配|多个不一致主体|图集照片数量超过/.test(error.message)) throw error;
        // An unavailable public endpoint does not erase known exact photo metadata; Edge may still enrich it.
      }
    }
    if (httpError || (reference.kind === "note" || snapshot?.images ? !completePhotos(snapshot) : !completeVideo(snapshot))) {
      signal.throwIfAborted(); current.onProgress?.("通过专用抖音 Edge 会话读取当前作品");
      let browser: SocialBrowserSnapshot | undefined;
      let browserError: unknown;
      try {
        const endpoint = new URL("https://www.douyin.com/aweme/v1/web/aweme/detail/"); endpoint.searchParams.set("aweme_id", reference.nativeId);
        browser = await (deps.captureBrowser ?? captureSocialBrowser)({ ...input, nativeId: reference.nativeId, canonicalUrl: reference.canonicalUrl }, current, [{ url: endpoint.toString(), method: "GET", headers: { Accept: "application/json" } }]);
      } catch (error) { signal.throwIfAborted(); browserError = error; }
      if (browser) {
        signal.throwIfAborted();
        const exact = browserWork(browser, reference.nativeId);
        if (exact) { snapshot = enrichSnapshot(snapshot, exact); retainBody(); }
        else if (browser.gated) throw new DouyinFailure("专用 Edge 页面要求会话或人机验证，请人工完成后重试", "login_required");
      } else if (httpError instanceof DouyinFailure && httpError.status === "login_required") {
        // A failed browser launch cannot prove that a known HTTP challenge was passed.
        if (browserError instanceof SocialBrowserError) throw new DouyinFailure(browserError.message, browserError.status);
        throw httpError;
      }
      if (!completeVideo(snapshot) && !snapshot?.images && reference.kind === "video") {
        signal.throwIfAborted();
        try { snapshot = enrichSnapshot(snapshot, await metadata(reference, current, deps, session.file)); retainBody(); }
        catch (error) {
          signal.throwIfAborted();
          if (browser && !browser.gated && error instanceof DouyinFailure && error.status === "login_required") throw new DouyinFailure("Edge 已加载目标页面，但未取得身份核验通过的原视频数据", "unavailable");
          if (browserError instanceof SocialBrowserError) throw new DouyinFailure(browserError.message, browserError.status);
          throw error;
        }
      }
    }
    if (!snapshot && reference.kind === "note") throw new DouyinFailure("未取得身份核验通过的抖音图集照片数据", "unavailable");
    if (!snapshot) throw new DouyinFailure("未取得身份核验通过的抖音作品数据", "unavailable");
    retainBody();
    await current.onCheckpoint?.(content);
    if (reference.kind === "note" || snapshot.images) {
      signal.throwIfAborted(); content.kind = "gallery";
      const { savePhotoCollection } = await import("./content-photo-media.js");
      return await savePhotoCollection(content, snapshot.photos ?? [], current, deps);
    }
    if (!snapshot.videoUrl || !snapshot.duration || deps.maxDurationSeconds !== undefined && snapshot.duration > deps.maxDurationSeconds) throw new DouyinFailure("原视频地址或完整时长不可核验，或超过本次样本预算", "unavailable");
    await publicHttpUrl(snapshot.videoUrl, signal);
    content.parts = [{ id: reference.nativeId, title: content.title, status: "unavailable", durationSeconds: snapshot.duration }];
    transaction = path.dirname(await writableFile(root, `.douyin-downloads/${randomUUID()}/transaction`));
    const asset = await savePublicAsset(snapshot.videoUrl, transaction, "source/001", "video", signal, maximum);
    if (asset.status !== "saved" || !asset.path) throw new DouyinFailure(asset.reason || "抖音原视频未保存完整");
    const file = await containedFile(transaction, asset.path);
    const checked = await probe(file, current, deps); signal.throwIfAborted();
    if (!checked) throw new DouyinFailure("下载视频尚未通过 ffprobe 核验", "missing_dependency");
    if (!checked.video || !Number.isFinite(checked.durationSeconds) || checked.durationSeconds! <= 0) throw new DouyinFailure("下载文件没有可核验的视频流和时长");
    if (Math.abs(checked.durationSeconds! - snapshot.duration) > Math.max(0.5, snapshot.duration * 0.03)) throw new DouyinFailure("下载视频时长与当前作品元数据不符");
    const bytes = (await fs.stat(file)).size; if (!bytes || bytes > maximum) throw new DouyinFailure("原视频为空或超过保存上限");
    const sha256 = await fileHash(file); signal.throwIfAborted();
    const relative = "video/001.mp4"; await atomicReplace(file, await writableFile(root, relative));
    content.assets.push({ id: "video/001", role: "video", status: "saved", path: relative, capturePath: relative, bytes, sha256, mime: "video/mp4", partId: reference.nativeId, provenance: "original" });
    content.parts[0].status = "saved"; content.coverage!.media = "saved: 1 verified original video"; content.coverage!.duration = `metadata=${snapshot.duration}s actual=${checked.durationSeconds}s verified`;
    await current.onCheckpoint?.(content); return content;
  } catch (error) {
    const reason = context.signal?.aborted ? "抖音采集已取消" : signal.aborted ? "抖音采集超时" : error instanceof DouyinFailure ? error.message : "抖音采集失败（网络、会话或本地文件异常）";
    const status = context.signal?.aborted || signal.aborted ? "unavailable" : error instanceof DouyinFailure ? error.status : "failed";
    const failureId = content.kind === "gallery" ? "images/001" : "video/001";
    const savedOriginal = content.assets.some(asset => asset.status === "saved" && (asset.role === "video" || content.kind === "gallery" && asset.role === "image"));
    if (!savedOriginal && !content.assets.some(asset => asset.id === failureId)) content.assets.push({ id: failureId, role: content.kind === "gallery" ? "image" : "video", status, reason, provenance: "original" });
    if (content.parts?.[0] && content.parts[0].status !== "saved") { content.parts[0].status = status === "failed" ? "failed" : "unavailable"; content.parts[0].reason = reason; }
    content.coverage!.media = context.signal?.aborted ? "cancelled" : `${status}: ${reason}`; content.warnings.push(publicValue(reason)); await current.onCheckpoint?.(content); return content;
  } finally {
    if (transaction && root && path.dirname(transaction) === path.join(root, ".douyin-downloads") && isPathWithin(root, transaction)) await fs.rm(transaction, { recursive: true, force: true }).catch(() => {});
  }
}

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { load } from "cheerio";
import TurndownService from "turndown";
import { fetchPublic, fetchedPublicUrl, privateAddress, savePublicAsset } from "./content-network.js";
import { atomicReplace, containedFile, fileHash, publicUrl, publicValue, writableFile } from "./content-library.js";
import { runContentTool } from "./content-tools.js";
import { weiboPostReference, weiboMidToBid, weiboBidToMid } from "./content-social-reference.js";
import { captureSocialBrowser, SocialBrowserError, type SocialBrowserJsonRequest, type SocialBrowserSnapshot } from "./content-social-browser.js";
import type { CapturedContent, ContentContext, ContentInput, ContentAsset } from "./content-types.js";
import type { AcquisitionDeps } from "./content-acquisition.js";

export interface WeiboDeps extends Pick<AcquisitionDeps, "runTool" | "probeMedia"> {
  /** Official API request injection; no third-party parser setting is used. */
  requestJson?: (url: string, init: RequestInit, context: ContentContext) => Promise<unknown>;
  fetch?: typeof fetchPublic;
  saveAsset?: typeof savePublicAsset;
  captureBrowser?: typeof captureSocialBrowser;
  maxVideoBytes?: number;
  maxTotalBytes?: number;
}
type Obj = Record<string, unknown>;
type Cookie = { domain: string; hostOnly: boolean; path: string; name: string; value: string; secure: boolean; expires: number };
type Video = { fid?: string; urls: Array<{ url: string; rank: number; bytes?: number }>; duration?: number };
const obj = (value: unknown): Obj => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const str = (value: unknown): string => typeof value === "string" ? value : "";
const identifier = (value: unknown): string => typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const API_MAX = 8 * 1024 * 1024, IMAGE_MAX = 20 * 1024 * 1024, MEDIA_MAX = 2 * 1024 * 1024 * 1024;
const MAX_IMAGES = 128, MAX_VIDEOS = 9;
const POST_IDS = ["mblogid", "bid", "idstr", "id_str", "mid", "id"] as const;
class WeiboFailure extends Error {
  constructor(message: string, readonly status: ContentAsset["status"] = "unavailable") { super(message); }
}
const checkpoint = async (context: ContentContext, record: CapturedContent) => { await context.onCheckpoint?.(record); };
const title = (value: string) => Array.from(value.replace(/\s+/g, " ").trim()).slice(0, 160).join("") || "微博帖子";
function apiError(value: unknown): void {
  const data = obj(value), code = identifier(data.errno ?? data.error_code), message = str(data.msg ?? data.message ?? data.error);
  if (data.ok === 0 || data.error_code || data.code !== undefined && ![100000, "100000", 200, "200"].includes(data.code as string | number)) {
    throw new WeiboFailure(/213\d+/.test(code) || /login|登录|验证|未授权|visitor/i.test(message) ? "微博接口需要专用登录或验证" : "微博接口本轮未返回可取得的目标内容", /213\d+/.test(code) || /login|登录|验证|未授权|visitor/i.test(message) ? "login_required" : "unavailable");
  }
}
function postBid(post: Obj): string | undefined {
  if (POST_IDS.some(key => key in post && !identifier(post[key]))) return undefined;
  const bids = [post.mblogid, post.bid].map(identifier).filter(Boolean);
  const mids = [post.idstr, post.id_str, post.mid, post.id].map(identifier).filter(Boolean);
  for (const mid of mids) { const converted = weiboMidToBid(mid); if (!converted) return undefined; bids.push(converted); }
  return bids.length && bids.every(b => b === bids[0]) && weiboBidToMid(bids[0]) ? bids[0] : undefined;
}
function boundText(post: Obj, bid: string): boolean {
  return !POST_IDS.some(key => key in post) || postBid(post) === bid;
}
function officialApiKey(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
    const desktop = ["weibo.com", "www.weibo.com"].includes(url.hostname), mobile = url.hostname === "m.weibo.cn";
    if (desktop && url.pathname === "/tv/api/component") {
      if (url.searchParams.getAll("page").length !== 1) return undefined;
      const target = weiboPostReference(new URL(url.searchParams.get("page")!, "https://weibo.com").toString());
      return target?.kind === "video" ? `component:${target.fid}` : undefined;
    }
    const show = desktop && url.pathname === "/ajax/statuses/show" || mobile && ["/statuses/show", "/api/statuses/show"].includes(url.pathname);
    const long = desktop && url.pathname === "/ajax/statuses/longtext" || mobile && ["/statuses/extend", "/api/statuses/extend"].includes(url.pathname);
    if ((!show && !long) || url.searchParams.getAll("id").length !== 1) return undefined;
    const id = url.searchParams.get("id")!, bid = /^\d+$/.test(id) ? weiboMidToBid(id) : weiboBidToMid(id) ? id : undefined;
    return bid ? `${show ? "show" : "long"}:${bid}` : undefined;
  } catch { return undefined; }
}
function postRequests(bid: string, mid: string): SocialBrowserJsonRequest[] {
  return [
    { url: `https://weibo.com/ajax/statuses/show?id=${bid}` },
    { url: `https://m.weibo.cn/statuses/show?id=${mid}` },
    { url: `https://weibo.com/ajax/statuses/longtext?id=${bid}` },
    { url: `https://m.weibo.cn/statuses/extend?id=${mid}` }
  ];
}
function exactComponent(value: unknown, fid: string): Obj {
  apiError(value);
  const component = obj(obj(obj(value).data).Component_Play_Playinfo);
  if (!Object.keys(component).length || ["oid", "object_id", "fid", "objectid"].some(key => key in component && identifier(component[key]) !== fid)) throw new WeiboFailure("TV 返回目标视频身份不一致");
  if (!weiboMidToBid(identifier(component.mid))) throw new WeiboFailure("TV 未提供可验证的帖子绑定身份");
  return component;
}
function extensionText(value: unknown, bid: string): string | undefined {
  try {
    apiError(value); const root = obj(value), data = obj(root.data);
    if (!boundText(root, bid) || !boundText(data, bid)) return undefined;
    return str(data.longTextContent) || undefined;
  } catch { return undefined; }
}
function embeddedText(post: Obj, bid: string): string {
  const long = obj(post.longText);
  return boundText(long, bid) ? str(long.longTextContent ?? post.longTextContent) : str(post.longTextContent);
}
function exactPost(value: unknown, bid: string): Obj {
  apiError(value);
  const root = obj(value), data = obj(root.data);
  const candidates = [root, data, obj(data.mblog), obj(data.status)];
  for (const candidate of candidates) if (postBid(candidate) === bid) return candidate;
  throw new WeiboFailure("微博响应的帖子身份与输入不一致，未选择推荐或其他帖子");
}
function plainHtml(value: string): string {
  const $ = load(value); $("script,style,noscript,iframe,object,embed,form,svg").remove();
  $("img").each((_, element) => { $(element).replaceWith($("<span>").text($(element).attr("alt") || "")); });
  $("a").each((_, element) => {
    const node = $(element), href = node.attr("href") || "";
    try { const url = new URL(href, "https://weibo.com/"); if (/^https?:$/.test(url.protocol) && !url.username && !url.password) { node.attr("href", publicUrl(url.toString())); return; } } catch {}
    node.replaceWith($("<span>").text(node.text()));
  });
  return new TurndownService({ headingStyle: "atx", bulletListMarker: "-" }).turndown($("body").html() || "").trim();
}
function truncated(post: Obj): boolean {
  if (post.isLongText === true || post.isLongText === 1 || post.isLongText === "1") return true;
  const $ = load(str(post.text));
  return $("a").toArray().some(element => /^(展开)?全文$/.test($(element).text().trim()));
}
function safeMedia(value: unknown, video: boolean, explicit = false): string | undefined {
  if (typeof value !== "string" || value.length > 16384) return undefined;
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || privateAddress(url.hostname) || /(^|\.)(localhost|local)$/i.test(url.hostname)) return undefined;
    if (/\.(?:m3u8|mpd)$/i.test(url.pathname)) return undefined;
    if (video && !explicit && !/\.mp4$/i.test(url.pathname)) return undefined;
    return url.toString();
  } catch { return undefined; }
}
function images(post: Obj): { urls: string[]; expected: number } {
  const values: unknown[] = [], infos = obj(post.pic_infos), ids = Array.isArray(post.pic_ids) ? post.pic_ids.map(identifier) : [];
  const best = (value: unknown) => { const image = obj(value); return [obj(image.largest).url, obj(image.original).url, obj(image.large).url, obj(image.bmiddle).url, image.url].find(v => safeMedia(v, false)); };
  if (ids.length) for (const id of ids) values.push(best(infos[id]));
  if (Array.isArray(post.pics)) for (const pic of post.pics) { const image = obj(pic); if (!ids.length || ids.includes(identifier(image.pid ?? image.pic_id))) values.push(best(image)); }
  const mix = obj(post.mix_media_info);
  if (Array.isArray(mix.items)) for (const item of mix.items) if (obj(item).type === "pic") values.push(best(obj(item).data));
  const urls = [...new Set(values.map(v => safeMedia(v, false)).filter((v): v is string => !!v))];
  const count = Number(post.pic_num);
  return { urls, expected: Math.max(urls.length, ids.length, Number.isSafeInteger(count) && count > 0 ? count : 0) };
}
function fidOf(value: Obj): string | undefined {
  const id = identifier(value.oid ?? value.object_id ?? value.fid ?? value.objectid);
  return /^\d+:(?:[0-9a-f]{32}|[1-9]\d{15,21})$/.test(id) ? id : undefined;
}
function parseVideo(page: Obj): Video {
  const media = obj(page.media_info), urls: Video["urls"] = [];
  const encrypted = [page, media].some(o => o.has_drm || o.encrypted || o.isEncrypted || o.decode_key || o.decrypt_key || o.decodeKey);
  if (!encrypted) {
    if (Array.isArray(media.playback_list)) for (const item of media.playback_list) {
      const play = obj(obj(item).play_info), url = safeMedia(play.url, true, play.mime === "video/mp4");
      if (url) urls.push({ url, rank: (Number(play.height) || 0) * 100000 + (Number(play.bitrate) || 0), bytes: Number(play.size) || undefined });
    }
    for (const [key, rank] of [["stream_url_hd", 72000000], ["mp4_720p_mp4", 72000000], ["mp4_hd_url", 72000000], ["stream_url", 48000000], ["mp4_sd_url", 36000000]] as const) { const url = safeMedia(media[key], true); if (url) urls.push({ url, rank }); }
    for (const [key, value] of Object.entries(obj(page.urls))) { const url = safeMedia(value, true); if (url) urls.push({ url, rank: /1080|超清/.test(key) ? 108000000 : /720|高清/.test(key) ? 72000000 : 36000000 }); }
  }
  const duration = Number(media.duration ?? media.video_duration ?? page.duration);
  return { fid: fidOf(page), urls: [...new Map(urls.sort((a, b) => b.rank - a.rank).map(item => [item.url, item])).values()], duration: Number.isFinite(duration) && duration > 0 ? duration : undefined };
}
function videos(post: Obj): Video[] {
  const output: Video[] = [], page = obj(post.page_info), original = obj(obj(post.retweeted_status).page_info);
  const ownPage = !Object.keys(obj(post.retweeted_status)).length || fidOf(page) && fidOf(page) !== fidOf(original);
  if (ownPage && (page.type === "video" || page.object_type === "video" || fidOf(page))) output.push(parseVideo(page));
  const mix = obj(post.mix_media_info);
  if (Array.isArray(mix.items)) for (const item of mix.items) if (obj(item).type === "video") output.push(parseVideo(obj(obj(item).data)));
  return output.filter((video, index, all) => !video.fid || all.findIndex(other => other.fid === video.fid) === index);
}
async function boundedText(response: Response, signal?: AbortSignal): Promise<string> {
  const size = Number(response.headers.get("content-length"));
  if (size > API_MAX) { await response.body?.cancel(); throw new WeiboFailure("微博接口正文超过读取上限"); }
  if (!response.body) throw new WeiboFailure("微博接口没有响应正文");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { signal?.throwIfAborted(); const item = await reader.read(); if (item.done) break; bytes += item.value.byteLength; if (bytes > API_MAX) throw new WeiboFailure("微博接口正文超过读取上限"); chunks.push(item.value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
async function profileCookies(context: ContentContext): Promise<Cookie[]> {
  const directory = path.join(context.runtimeRoot, ".content-profile/weibo"), file = path.join(directory, "cookies.txt");
  const stat = await fs.lstat(file).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!stat) return [];
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new WeiboFailure("微博专用 Cookie 文件不安全或超过上限", "login_required");
  const text = await fs.readFile(await containedFile(directory, "cookies.txt"), "utf8"), cookies: Cookie[] = [];
  for (let line of text.split(/\r?\n/)) {
    if (line.startsWith("#HttpOnly_")) line = line.slice(10); else if (line.startsWith("#")) continue;
    const fields = line.split("\t"); if (fields.length !== 7 || !/(^|\.)weibo\.(com|cn)$/i.test(fields[0])) continue;
    const [domain, includeSubdomains, cookiePath, secure, expires, name, value] = fields;
    if (!["TRUE", "FALSE"].includes(includeSubdomains)) continue;
    if (/[^!#$%&'*+\-.^_`|~0-9a-z]/i.test(name) || /[\x00-\x20\x7f;]/.test(value)) continue;
    cookies.push({ domain: domain.replace(/^\./, "").toLowerCase(), hostOnly: includeSubdomains !== "TRUE", path: cookiePath || "/", secure: secure === "TRUE", expires: Number(expires) || 0, name, value });
  }
  return cookies;
}
async function officialRequester(context: ContentContext, deps: WeiboDeps): Promise<(url: string, init?: RequestInit) => Promise<unknown>> {
  if (deps.requestJson) return (url, init = {}) => deps.requestJson!(url, init, context);
  const cookies = await profileCookies(context), transport = deps.fetch ?? fetchPublic; let visitor = false;
  const get = async (url: string, init: RequestInit = {}) => {
    const target = new URL(url), headers = new Headers({ "User-Agent": UA, Referer: "https://weibo.com/", ...Object.fromEntries(new Headers(init.headers)) });
    const applicable = cookies.filter(c => (target.hostname === c.domain || !c.hostOnly && target.hostname.endsWith(`.${c.domain}`)) && target.pathname.startsWith(c.path) && (c.path.endsWith("/") || target.pathname.length === c.path.length || target.pathname[c.path.length] === "/") && (!c.secure || target.protocol === "https:") && (!c.expires || c.expires > Date.now() / 1000));
    if (applicable.length) headers.set("cookie", applicable.map(c => `${c.name}=${c.value}`).join("; "));
    const xsrf = applicable.find(c => c.name === "XSRF-TOKEN"); if (xsrf) { try { const value = decodeURIComponent(xsrf.value); if (!/[\r\n]/.test(value)) headers.set("x-xsrf-token", value); } catch {} }
    const response = await transport(url, { ...init, headers }, context.signal), final = new URL(fetchedPublicUrl(response) || url);
    if (!/(^|\.)weibo\.(com|cn)$/i.test(final.hostname)) { await response.body?.cancel(); throw new WeiboFailure("微博接口跳转到无关来源，已停止"); }
    for (const raw of response.headers.getSetCookie()) {
      const parts = raw.split(";"), match = /^([^=]+)=(.*)$/.exec(parts[0]); if (!match) continue;
      const lastSlash = final.pathname.lastIndexOf("/"), defaultPath = lastSlash > 0 ? final.pathname.slice(0, lastSlash) : "/";
      let domain = final.hostname, hostOnly = true, cookiePath = defaultPath, secure = false, expires = 0;
      for (const part of parts.slice(1)) { const [key, ...rest] = part.trim().split("="), value = rest.join("="); if (key.toLowerCase() === "domain") { domain = value.replace(/^\./, "").toLowerCase(); hostOnly = false; } if (key.toLowerCase() === "path") cookiePath = value; if (key.toLowerCase() === "secure") secure = true; if (key.toLowerCase() === "expires") expires = Date.parse(value) / 1000; }
      if (!/(^|\.)weibo\.(com|cn)$/i.test(domain) || !(final.hostname === domain || final.hostname.endsWith(`.${domain}`)) || /[\x00-\x20\x7f;]/.test(match[2])) continue;
      const normalizedPath = cookiePath.startsWith("/") ? cookiePath : defaultPath;
      const entry = { domain, hostOnly, path: normalizedPath, secure, expires, name: match[1], value: match[2] }, index = cookies.findIndex(c => c.domain === domain && c.path === normalizedPath && c.name === entry.name);
      if (index < 0) cookies.push(entry); else cookies[index] = entry;
    }
    const text = await boundedText(response, context.signal);
    return { response, text, final };
  };
  const bootstrap = async (referer: string) => {
    visitor = true;
    const generated = await get("https://passport.weibo.com/visitor/genvisitor", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: referer }, body: new URLSearchParams({ cb: "gen_callback", fp: JSON.stringify({ os: "1", browser: "Chrome130,0,0,0", fonts: "undefined", screenInfo: "1920*1080*24", plugins: "" }) }).toString() });
    let data: Obj; try { const source = generated.text.trim(), json = source.startsWith("{") ? source : /^(?:(?:window\.)?gen_callback\s*&&\s*)?gen_callback\((\{[\s\S]*\})\);?$/.exec(source)?.[1]; data = obj(obj(JSON.parse(json || "")).data); } catch { throw new WeiboFailure("微博正常访客初始化未完成", "login_required"); }
    const tid = str(data.tid); if (!tid || tid.length > 512 || /[\r\n]/.test(tid)) throw new WeiboFailure("微博访客初始化要求登录或验证", "login_required");
    const query = new URLSearchParams({ a: "incarnate", t: tid, w: data.new_tid ? "3" : "2", c: String(Math.max(0, Math.min(100, Number(data.confidence) || 100))).padStart(3, "0"), gc: "", cb: "cross_domain", from: "weibo", _rand: "0.5" });
    await get(`https://passport.weibo.com/visitor/visitor?${query}`, { headers: { Referer: referer } });
  };
  return async (url, init = {}) => {
    let result = await get(url, init);
    if (result.final.hostname.includes("passport") && !visitor) { await bootstrap(result.final.toString()); result = await get(url, init); }
    if ([401, 403].includes(result.response.status) || result.final.hostname.includes("passport")) throw new WeiboFailure("微博需要专用登录或验证；本轮未绕过", "login_required");
    if (!result.response.ok) throw new WeiboFailure(`微博接口 HTTP ${result.response.status}，本轮未取得`);
    try { return JSON.parse(result.text); } catch {
      if (/验证码|安全验证|<input[^>]+(?:captcha|verifycode)/i.test(result.text)) throw new WeiboFailure("微博页面需要专用登录或验证；本轮未绕过", "login_required");
      throw new WeiboFailure("微博接口没有返回可用 JSON", "login_required");
    }
  };
}
async function probe(file: string, context: ContentContext, deps: WeiboDeps): Promise<Awaited<ReturnType<NonNullable<WeiboDeps["probeMedia"]>>>> {
  if (deps.probeMedia) return deps.probeMedia(file, context);
  const command = process.env.CONTENT_FFPROBE_PATH || path.join(context.runtimeRoot, "tools", process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  const args = ["-protocol_whitelist", "file,pipe", "-v", "error", "-f", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-show_entries", "stream=codec_type:format=duration", "-of", "json", file];
  const result = deps.runTool ? await deps.runTool(command, args, context) : await runContentTool({ command, args, signal: context.signal, timeoutMs: 15000, maxOutputBytes: 32000 });
  if (result.code || result.timedOut || result.cancelled || result.outputTruncated) return undefined;
  try { const data = JSON.parse(result.stdout); return { video: data.streams?.some((s: Obj) => s.codec_type === "video") === true, audio: data.streams?.some((s: Obj) => s.codec_type === "audio") === true, durationSeconds: Number(data.format?.duration) }; } catch { return undefined; }
}
async function verifiedFile(asset: ContentAsset, context: ContentContext, maximum: number): Promise<string> {
  if (asset.status !== "saved" || !asset.path) throw new WeiboFailure("媒体未下载完成", "failed");
  const file = await containedFile(context.directory, asset.path), stat = await fs.stat(file);
  if (!stat.size || stat.size > maximum || asset.bytes && stat.size !== asset.bytes || asset.sha256 && await fileHash(file) !== asset.sha256) throw new WeiboFailure("媒体字节数或哈希核验失败", "failed");
  asset.bytes = stat.size; asset.sha256 = await fileHash(file); asset.provenance = "original";
  return file;
}
async function verifiedImage(file: string): Promise<boolean> {
  const handle = await fs.open(file, "r"), buffer = Buffer.alloc(16); try { await handle.read(buffer, 0, 16, 0); } finally { await handle.close(); }
  return buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) || buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || /^GIF8[79]a/.test(buffer.toString("ascii", 0, 6)) || buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP" || buffer.toString("ascii", 4, 8) === "ftyp" && /avif|avis/.test(buffer.toString("ascii", 8, 16));
}
async function saveVerified(url: string, stem: string, role: "image" | "video", context: ContentContext, deps: WeiboDeps, maximum: number, inspect: (file: string) => Promise<void>): Promise<ContentAsset> {
  const root = path.resolve(context.directory);
  let transaction: string | undefined;
  const failed = (status: ContentAsset["status"], reason: string): ContentAsset => ({ id: stem, role, status, reason, provenance: "original" });
  try {
    context.signal?.throwIfAborted();
    transaction = path.dirname(await writableFile(root, `.weibo-downloads/${randomUUID()}/transaction`));
    // A prior final file is never a download target or a trusted file inside this transaction.
    const asset = await (deps.saveAsset ?? savePublicAsset)(url, transaction, stem, role, context.signal, maximum);
    if (asset.status !== "saved") return failed(asset.status, "目标媒体下载未完成，已有原始文件未被替换");
    asset.id = stem; asset.role = role;
    const relative = asset.path || "", prefix = `${stem}.`;
    if (!relative.startsWith(prefix) || !/^[a-z0-9]{1,8}$/.test(relative.slice(prefix.length))) throw new WeiboFailure("下载媒体路径不符合当前目标", "failed");
    const file = await verifiedFile(asset, { ...context, directory: transaction }, maximum);
    await inspect(file); context.signal?.throwIfAborted();
    const destination = await writableFile(root, relative); context.signal?.throwIfAborted();
    await atomicReplace(file, destination);
    return { ...asset, capturePath: relative };
  } catch (error) {
    if (context.signal?.aborted) throw error;
    return failed(error instanceof WeiboFailure ? error.status : "failed", error instanceof WeiboFailure ? error.message : "目标媒体核验或替换失败，已有原始文件未被替换");
  } finally {
    if (transaction) {
      const resolvedRoot = await fs.realpath(root).catch(() => undefined), resolvedTransaction = await fs.realpath(transaction).catch(() => undefined);
      if (resolvedRoot && resolvedTransaction && path.dirname(resolvedTransaction) === path.join(resolvedRoot, ".weibo-downloads") && /^[0-9a-f-]{36}$/.test(path.basename(resolvedTransaction)) && !await fs.lstat(transaction).then(stat => stat.isSymbolicLink(), () => true)) await fs.rm(resolvedTransaction, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Acquire exactly one Weibo post or TV target. Every media byte uses the shared safe downloader. */
export async function acquireWeibo(input: ContentInput, context: ContentContext, deps: WeiboDeps = {}): Promise<CapturedContent> {
  const record: CapturedContent = { platform: input.platform, nativeId: input.nativeId, sourceUrl: input.url, canonicalUrl: input.canonicalUrl, title: "微博帖子", capturedAt: new Date().toISOString(), kind: "article", markdown: "", assets: [], warnings: [], coverage: { body: "unknown", media: "not_attempted", comments: "not_attempted" } };
  const signal = AbortSignal.any([AbortSignal.timeout(5 * 60000), ...(context.signal ? [context.signal] : [])]), current = { ...context, signal };
  try {
    signal.throwIfAborted();
    const raw = weiboPostReference(input.url), canonical = weiboPostReference(input.canonicalUrl), reference = canonical || raw;
    if (input.platform !== "weibo" || !reference || raw && canonical && raw.nativeId !== canonical.nativeId || input.nativeId && input.nativeId !== reference.nativeId) throw new WeiboFailure("输入不是一致的微博单帖/目标 TV 视频身份");
    record.nativeId = reference.nativeId; record.canonicalUrl = reference.canonicalUrl;
    const request = await officialRequester(current, deps);
    const browserPhases = new Set<"component" | "post">();
    const browserResponses: SocialBrowserSnapshot["responses"] = []; let browserGated = false;
    const markBrowser = () => { record.coverage!.acquisition = "saved: dedicated Edge official JSON"; };
    const browserFailure = () => new WeiboFailure(browserGated ? "微博专用 Edge 页面需要登录或验证；没有可核对的目标 JSON" : "微博专用 Edge 未返回可核对的目标官方 JSON", browserGated ? "login_required" : "unavailable");
    const readBrowser = async (phase: "component" | "post", requests: SocialBrowserJsonRequest[]) => {
      signal.throwIfAborted(); if (browserPhases.has(phase)) return;
      browserPhases.add(phase);
      let snapshot: SocialBrowserSnapshot;
      try { snapshot = await (deps.captureBrowser ?? captureSocialBrowser)({ ...input, nativeId: reference.nativeId, canonicalUrl: reference.canonicalUrl }, current, requests); }
      catch (error) {
        signal.throwIfAborted();
        const detail = error instanceof Error ? publicValue(error.message).slice(0, 1500) : "未返回可诊断错误";
        throw new WeiboFailure(`微博专用 Edge 未完成目标读取：${detail}`, error instanceof SocialBrowserError ? error.status : "failed");
      }
      signal.throwIfAborted();
      let final: URL; try { final = new URL(snapshot.finalUrl); } catch { throw new WeiboFailure("微博专用 Edge 未返回有效目标页面地址"); }
      if (final.protocol !== "https:" || final.username || final.password || final.port || !/(^|\.)weibo\.(com|cn)$/i.test(final.hostname)) throw new WeiboFailure("微博专用 Edge 停留在无关页面，未选择页面内容");
      const target = weiboPostReference(snapshot.finalUrl);
      if (target && target.nativeId !== reference.nativeId || !target && !snapshot.gated) throw new WeiboFailure("微博专用 Edge 页面身份与输入不一致");
      browserGated = snapshot.gated;
      for (const response of snapshot.responses.slice(0, 40)) if (officialApiKey(response.url)) browserResponses.push(response);
    };
    const browserValues = (key: string) => browserResponses.filter(response => officialApiKey(response.url) === key).map(response => response.data);
    const browserPost = (bid: string): Obj | undefined => {
      for (const value of browserValues(`show:${bid}`)) try { const post = exactPost(value, bid); markBrowser(); return post; } catch {}
      return undefined;
    };
    const getPost = async (bid: string, mid: string): Promise<Obj> => {
      for (const item of postRequests(bid, mid).slice(0, 2)) {
        try { signal.throwIfAborted(); return exactPost(await request(item.url), bid); } catch (error) { if (signal.aborted) throw error; }
      }
      const cached = browserPost(bid); if (cached) return cached;
      await readBrowser("post", postRequests(bid, mid));
      const rendered = browserPost(bid); if (rendered) return rendered;
      throw browserFailure();
    };
    let expectedBid = reference.bid, expectedMid = reference.mid, component: Obj | undefined;
    if (reference.kind === "video") {
      record.kind = "video";
      const item: SocialBrowserJsonRequest = { url: `https://weibo.com/tv/api/component?page=${encodeURIComponent(`/tv/show/${reference.fid}`)}`, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ data: JSON.stringify({ Component_Play_Playinfo: { oid: reference.fid } }) }).toString() };
      try { component = exactComponent(await request(item.url, { ...item, headers: { ...item.headers, Referer: reference.canonicalUrl } }), reference.fid!); }
      catch (error) {
        signal.throwIfAborted(); await readBrowser("component", [item]);
        for (const value of browserValues(`component:${reference.fid}`)) try { component = exactComponent(value, reference.fid!); markBrowser(); break; } catch {}
        if (!component) throw browserFailure();
      }
      expectedMid = identifier(component.mid); expectedBid = weiboMidToBid(expectedMid);
      if (!expectedBid) throw new WeiboFailure("TV 未提供可验证的帖子绑定身份");
    }
    const post = await getPost(expectedBid!, expectedMid!), ownVideos = videos(post);
    let selectedVideos = ownVideos;
    if (reference.kind === "video") {
      selectedVideos = ownVideos.filter(video => video.fid === reference.fid);
      if (!selectedVideos.length && component && fidOf(component) === reference.fid) selectedVideos = [parseVideo({ ...component, media_info: component.media_info ?? component })];
      if (!selectedVideos.length) throw new WeiboFailure("TV 与帖子媒体没有精确的 FID 绑定证据，未下载其他视频");
    }
    const embeddedLong = embeddedText(post, expectedBid!);
    let body = embeddedLong ? plainHtml(embeddedLong) : str(post.text_raw) || plainHtml(str(post.text)), complete = !truncated(post) || !!embeddedLong;
    if (!complete) for (const url of [`https://weibo.com/ajax/statuses/longtext?id=${expectedBid}`, `https://m.weibo.cn/statuses/extend?id=${expectedMid}`]) {
      try { const full = extensionText(await request(url), expectedBid!); if (full) { body = plainHtml(full); complete = true; break; } } catch { if (signal.aborted) signal.throwIfAborted(); }
    }
    if (!complete) {
      try {
        await readBrowser("post", postRequests(expectedBid!, expectedMid!));
        for (const value of browserValues(`long:${expectedBid}`)) {
          const full = extensionText(value, expectedBid!); if (full) { body = plainHtml(full); complete = true; markBrowser(); break; }
        }
        if (!complete) {
          const rendered = browserPost(expectedBid!);
          if (rendered) {
            const embedded = embeddedText(rendered, expectedBid!), full = embedded ? plainHtml(embedded) : !truncated(rendered) ? str(rendered.text_raw) || plainHtml(str(rendered.text)) : "";
            if (full) { body = full; complete = true; }
          }
        }
        if (!complete && browserGated) throw browserFailure();
      } catch (error) {
        signal.throwIfAborted(); const failure = error instanceof WeiboFailure ? error : new WeiboFailure("微博 Edge 长文读取未完成");
        record.assets.push({ id: "weibo-browser-longtext", role: "source", status: failure.status, provenance: "generated", reason: failure.message });
      }
    }
    if (Buffer.byteLength(body, "utf8") > 4 * 1024 * 1024) throw new WeiboFailure("微博正文超过索引上限，未截断后冒充全文");
    record.markdown = body; record.title = title(body.split(/\r?\n/)[0]); record.author = str(obj(post.user).screen_name) || undefined;
    const published = Date.parse(str(post.created_at)); if (Number.isFinite(published)) record.publishedAt = new Date(published).toISOString();
    record.coverage = { ...record.coverage, body: complete ? "saved: full post text" : "unknown: long text truncated", postIdentity: `已核对原帖 ${expectedBid}；原博/推荐/头像/评论未纳入`, media: "not_attempted" };
    if (!complete) record.warnings.push("微博长文未取得完整扩展正文；已保留可取得片段，不标为全文");
    const pictures = reference.kind === "post" ? images(post) : { urls: [], expected: 0 };
    record.kind = selectedVideos.length || reference.kind === "video" ? "video" : pictures.expected ? "gallery" : "article";
    await checkpoint(current, record);
    const totalMaximum = Math.min(MEDIA_MAX, deps.maxTotalBytes ?? MEDIA_MAX), videoMaximum = Math.min(MEDIA_MAX, deps.maxVideoBytes ?? MEDIA_MAX);
    if (!Number.isSafeInteger(totalMaximum) || totalMaximum <= 0 || !Number.isSafeInteger(videoMaximum) || videoMaximum <= 0) throw new WeiboFailure("微博媒体预算必须是正整数");
    let used = 0;
    for (const [index, url] of pictures.urls.slice(0, MAX_IMAGES).entries()) {
      signal.throwIfAborted(); const stem = `assets/weibo/image-${String(index + 1).padStart(3, "0")}`, maximum = Math.min(IMAGE_MAX, totalMaximum - used);
      let asset: ContentAsset;
      if (maximum <= 0) asset = { id: stem, role: "image", status: "skipped", reason: "微博媒体总预算已用完", provenance: "original" };
      else {
        asset = await saveVerified(url, stem, "image", current, deps, maximum, async file => { if (!await verifiedImage(file)) throw new WeiboFailure("图片文件头无效，未登记为保存成功", "failed"); });
        if (asset.status === "saved") used += asset.bytes!;
      }
      record.assets.push(asset); await checkpoint(current, record);
    }
    if (pictures.expected > Math.min(pictures.urls.length, MAX_IMAGES)) { record.assets.push({ id: "weibo-images-missing", role: "image", status: "unavailable", provenance: "original", reason: `帖子声明 ${pictures.expected} 张图片，本轮只取得 ${Math.min(pictures.urls.length, MAX_IMAGES)} 个可用目标地址` }); record.warnings.push("原帖图片覆盖未完整，缺失部分已标记"); }
    record.parts = selectedVideos.length ? [] : undefined;
    for (const [index, video] of selectedVideos.slice(0, MAX_VIDEOS).entries()) {
      signal.throwIfAborted(); const stem = `assets/weibo/video-${String(index + 1).padStart(3, "0")}`, partId = `weibo-video-${index + 1}`;
      let asset: ContentAsset = { id: stem, role: "video", status: "unavailable", provenance: "original", partId, reason: "未取得可安全下载的目标 MP4（分段流/加密/无地址未下载）" }, duration: number | undefined;
      const maximum = Math.min(videoMaximum, totalMaximum - used);
      if (maximum <= 0) asset = { ...asset, status: "skipped", reason: "微博媒体总预算已用完" };
      else for (const candidate of video.urls.filter(item => !item.bytes || item.bytes <= maximum).slice(0, 2)) {
        const fetched = await saveVerified(candidate.url, stem, "video", current, deps, maximum, async file => {
          const inspected = await probe(file, current, deps);
          if (!inspected?.video || !Number.isFinite(inspected.durationSeconds) || inspected.durationSeconds! <= 0) throw new WeiboFailure("原视频未通过本地视频流和时长核验", inspected ? "failed" : "missing_dependency");
          duration = inspected.durationSeconds;
          if (video.duration && Math.abs(duration! - video.duration) > Math.max(0.5, video.duration * 0.03)) throw new WeiboFailure("原视频实测时长与接口目标不一致，未标为保存成功", "failed");
        });
        asset = { ...fetched, partId };
        if (asset.status === "saved") { used += asset.bytes!; break; }
      }
      record.assets.push(asset); record.parts!.push({ id: partId, title: `${record.title} ${index + 1}`, status: asset.status === "saved" ? "saved" : "partial", durationSeconds: duration ?? video.duration, reason: asset.status === "saved" ? undefined : asset.reason }); await checkpoint(current, record);
    }
    if (selectedVideos.length > MAX_VIDEOS) { record.warnings.push("单帖视频超过本轮数量上限，未标记全量取得"); record.coverage.media = "unknown: video count exceeds limit"; }
    else record.coverage.media = record.assets.some(a => a.status !== "saved") ? "unknown: some target media unavailable" : `saved: ${record.assets.filter(a => a.status === "saved").length} verified target assets`;
    await checkpoint(current, record); return record;
  } catch (error) {
    if (signal.aborted) { record.warnings.push("微博采集已取消或超时；已核验保存的原始资料保留"); record.coverage = { ...record.coverage, media: "cancelled" }; }
    else { const failure = error instanceof WeiboFailure ? error : new WeiboFailure("微博官方接口请求未完成；本轮未取得目标内容", "failed"); record.assets.push({ id: "weibo-acquisition-error", role: "source", status: failure.status, provenance: "generated", reason: failure.message }); record.warnings.push(failure.message); }
    await checkpoint(context, record); return record;
  }
}

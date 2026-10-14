import { createHash, randomUUID } from "node:crypto";
import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright-core";
import { resolveEdgeExecutable, isPathWithin } from "./url-policy.js";
import type { ContentAsset, ContentPlatform } from "./content-types.js";
import { fileHash, writableFile, atomicReplace, ensureDirectory } from "./content-library.js";

const MAX_REDIRECTS = 5;
const finalUrls = new WeakMap<Response, string>();
const redirectUrls = new WeakMap<Response, string[]>();
const encodedResponses = new WeakSet<Response>();
const nativeFetch = globalThis.fetch;

/** Includes loopback, private, link-local, shared, multicast and documentation/reserved address ranges. */
export function privateAddress(address: string): boolean {
  let value = address.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(value);
  if (mapped) { const integer = (parseInt(mapped[1], 16) << 16) + parseInt(mapped[2], 16); value = `${(integer >>> 24) & 255}.${(integer >>> 16) & 255}.${(integer >>> 8) & 255}.${integer & 255}`; }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) { const [a, b] = v4.slice(1).map(Number); return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0) || a >= 224; }
  return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/i.test(value) || value.startsWith("ff") || value.startsWith("::ffff:");
}

export async function resolvePublicHost(host: string, signal?:AbortSignal): Promise<{ address: string; family: number }> {
  const deadline=AbortSignal.any([AbortSignal.timeout(10000),...(signal?[signal]:[])]);
  const records = await new Promise<Array<{address:string;family:number}>>((resolve,reject)=>{
    const abort=()=>reject(deadline.reason);if(deadline.aborted){abort();return;}
    deadline.addEventListener("abort",abort,{once:true});
    dns.lookup(host,{all:true}).then(resolve,reject).finally(()=>deadline.removeEventListener("abort",abort));
  });
  if (!records.length || records.some((record) => privateAddress(record.address))) throw new Error("不允许访问本机或私网地址");
  return records[0];
}

/** Rejects credentials and local/private targets before every network hop. */
export async function publicHttpUrl(value: string | URL, signal?:AbortSignal): Promise<URL> {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("链接格式无效"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只支持 HTTP(S) 链接");
  if (url.username || url.password) throw new Error("链接不能包含账号或密码");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || privateAddress(host)) throw new Error("不允许访问本机或私网地址");
  try { await resolvePublicHost(host,signal); } catch (error) { if(signal?.aborted)throw signal.reason;if (error instanceof Error && error.message.includes("私网")) throw error; throw new Error("无法解析公网域名或解析超时", { cause: error }); }
  return url;
}

async function pinnedResponse(url: URL, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  let body: Buffer | undefined;
  if (init.body != null) {
    if (typeof init.body === "string" || init.body instanceof URLSearchParams) body = Buffer.from(init.body.toString());
    else if (init.body instanceof ArrayBuffer) body = Buffer.from(init.body);
    else if (ArrayBuffer.isView(init.body)) body = Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength);
    else throw new Error("公网请求只支持文字或字节正文");
    if (/^(GET|HEAD)$/i.test(init.method ?? "GET")) throw new Error("GET/HEAD 请求不能包含正文");
  }
  const outgoingHeaders = new Headers(init.headers);
  if (body) outgoingHeaders.set("content-length", String(body.byteLength));
  const resolved = await resolvePublicHost(url.hostname,signal);
  return new Promise<Response>((resolve, reject) => {
    const pinnedLookup = (_host: string, options: unknown, callback?: (...args: unknown[]) => void) => {
      const done = (typeof options === "function" ? options : callback) as ((...args: unknown[]) => void) | undefined;
      if ((options as { all?: boolean })?.all) done?.(null, [{ address: resolved.address, family: resolved.family }]);
      else done?.(null, resolved.address, resolved.family);
    };
    const request = (url.protocol === "https:" ? https : http).request(url, { method: init.method ?? "GET", headers: Object.fromEntries(outgoingHeaders.entries()), signal: signal ?? init.signal ?? undefined, lookup: pinnedLookup as never, servername: url.hostname }, (incoming) => {
      const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      const encoding = headers.get("content-encoding")?.toLowerCase();
      const decoded = encoding === "gzip" ? incoming.pipe(createGunzip()) : encoding === "deflate" ? incoming.pipe(createInflate()) : encoding === "br" ? incoming.pipe(createBrotliDecompress()) : incoming;
      if(decoded!==incoming){incoming.once("error",error=>decoded.destroy(error));decoded.once("close",()=>incoming.destroy());}
      if (encoding && encoding !== "identity") { headers.delete("content-encoding"); headers.delete("content-length"); }
      const response = new Response(Readable.toWeb(decoded) as ReadableStream, { status: incoming.statusCode ?? 500, headers });
      if (encoding && encoding !== "identity") encodedResponses.add(response);
      resolve(response);
    });
    request.once("error", reject); request.end(body);
  });
}

export type PublicNetworkHop = (url:URL, init:RequestInit, signal?:AbortSignal)=>Promise<Response>;
export async function fetchPublic(value: string | URL, init: RequestInit = {}, signal?: AbortSignal, transport?:PublicNetworkHop): Promise<Response> {
  signal=AbortSignal.any([AbortSignal.timeout(5*60000),...(signal?[signal]:init.signal?[init.signal]:[])]);
  let current = await publicHttpUrl(value,signal);
  const chain = [current.toString()];
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = transport?await transport(current,init,signal):globalThis.fetch === nativeFetch ? await pinnedResponse(current, init, signal) : await fetch(current, { ...init, redirect: "manual", signal: signal ?? init.signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (response.url) await publicHttpUrl(response.url, signal);
      finalUrls.set(response, current.toString());
      redirectUrls.set(response, chain);
      return response;
    }
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => {});
    if (init.redirect === "error") throw new Error("该请求不允许重定向");
    if (!location) throw new Error("重定向缺少目标地址");
    const next = await publicHttpUrl(new URL(location, current),signal);
    const headers = new Headers(init.headers);
    if (next.origin !== current.origin) for (const key of ["authorization", "cookie", "proxy-authorization"]) headers.delete(key);
    const method = (init.method ?? "GET").toUpperCase();
    if ((response.status === 303 && method !== "HEAD") || ([301,302].includes(response.status) && method === "POST")) {
      headers.delete("content-length"); headers.delete("content-type"); init = { ...init, method: "GET", body: undefined, headers };
    } else init = { ...init, headers };
    current = next;
    chain.push(current.toString());
  }
  throw new Error("重定向次数过多");
}

/** Final redirect target recorded by fetchPublic; avoids persisting signed request URLs. */
export function fetchedPublicUrl(response: Response): string | undefined { return finalUrls.get(response) || response.url || undefined; }
/** Ephemeral, already checked hops; lets a share keep its object ID before an authentication landing page. */
export function fetchedPublicRedirects(response: Response): readonly string[] { return [...(redirectUrls.get(response) ?? [])]; }

function assetExtension(contentType: string, fallback = "bin"): string {
  const type = contentType.split(";", 1)[0].trim().toLowerCase();
  return ({ "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "video/mp4": "mp4", "video/webm": "webm", "text/vtt": "vtt", "application/pdf": "pdf" } as Record<string, string>)[type] ?? fallback;
}

const DOWNLOAD_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 5_000;
class RetryableDownloadError extends Error {
  constructor(message: string, readonly restart = false, readonly delayMs?: number) { super(message); }
}

function transientNetworkError(error: unknown): boolean {
  for (let depth = 0; error && typeof error === "object" && depth < 5; depth++) {
    const value = error as { code?: string; name?: string; cause?: unknown };
    if (value.name === "TimeoutError" || ["ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "ENETRESET", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(value.code ?? "")) return true;
    error = value.cause;
  }
  return false;
}

function contentLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (raw === null) return undefined;
  const length = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(length)) throw new Error("资源响应长度无效");
  return length;
}

function byteRange(response: Response): { start: number; end: number; total: number } | undefined {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get("content-range") ?? "");
  if (!match) return undefined;
  const [start, end, total] = match.slice(1).map(Number);
  return [start, end, total].every(Number.isSafeInteger) && start <= end && end < total ? { start, end, total } : undefined;
}

function strongEtag(response: Response): string | undefined {
  const tag = response.headers.get("etag") ?? "";
  return /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(tag) ? tag : undefined;
}

function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const delay = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
  return Number.isFinite(delay) ? Math.min(MAX_RETRY_DELAY_MS, Math.max(0, delay)) : undefined;
}

async function retryPause(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}

type ResumeState = { total: number; etag: string; finalUrl: string; mime?: string };

/** Reuse verified complete files; retry only this idempotent media GET, never parser POSTs. */
export async function savePublicAsset(sourceUrl: string, directory: string, relativeStem: string, role: ContentAsset["role"], signal?: AbortSignal, maxBytes = 100 * 1024 * 1024, trusted?: ContentAsset, transport?:typeof fetchPublic): Promise<ContentAsset> {
  const deadline = AbortSignal.any([AbortSignal.timeout(5 * 60000), ...(signal ? [signal] : [])]);
  let temporary: string | undefined;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let bytes = 0;
  let hash = createHash("sha256");
  let resume: ResumeState | undefined;
  const reset = async () => { await handle?.truncate(0); bytes = 0; hash = createHash("sha256"); resume = undefined; };
  try {
    deadline.throwIfAborted();
    const root = await fs.realpath(directory);
    const prefix = `${relativeStem.replaceAll("\\", "/")}.`;
    if (trusted?.status === "saved" && trusted.sha256 && trusted.sourceUrl === sourceUrl && trusted.path?.startsWith(prefix) && /^[a-z0-9]{1,8}$/.test(trusted.path.slice(prefix.length)) && trusted.bytes && trusted.bytes <= maxBytes) {
      await publicHttpUrl(sourceUrl, deadline);
      const existing = await writableFile(root, trusted.path);
      try {
        const stat = await fs.lstat(existing);
        if (stat.isFile() && stat.size > 0 && stat.size === trusted.bytes && await fileHash(existing) === trusted.sha256) {
          deadline.throwIfAborted();
          return { ...trusted, id: relativeStem, role, sourceUrl };
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }

    for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt++) {
      let response: Response | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const abortBody = () => { void reader?.cancel().catch(() => {}); };
      try {
        deadline.throwIfAborted();
        const requestHeaders = new Headers({ "accept-encoding": "identity" });
        const partial = resume && bytes > 0 && bytes < resume.total ? resume : undefined;
        if (partial) { requestHeaders.set("range", `bytes=${bytes}-`); requestHeaders.set("if-range", partial.etag); }
        response = await (transport??fetchPublic)(sourceUrl, { headers: requestHeaders }, deadline);
        if (partial && response.status === 416) throw new RetryableDownloadError("资源范围已变化，将重新下载", true);
        if (!response.ok || !response.body) {
          const message = `HTTP ${response.status}`;
          if ([408, 429].includes(response.status) || response.status >= 500 && response.status <= 599) throw new RetryableDownloadError(message, false, retryAfter(response));
          throw new Error(message);
        }
        const announced = contentLength(response);
        const range = response.status === 206 ? byteRange(response) : undefined;
        const encoded = encodedResponses.has(response) || ![null, "identity"].includes(response.headers.get("content-encoding"));
        const mime = response.headers.get("content-type") ?? undefined;
        const finalUrl = fetchedPublicUrl(response) ?? sourceUrl;
        const etag = strongEtag(response);
        if (announced !== undefined && announced > maxBytes || range && range.total > maxBytes) throw new Error("文件超过保存上限");
        if (/^text\/html\b/i.test(mime ?? "")) throw new Error("资源地址返回 HTML，可能要求登录或已失效");
        if (partial && response.status === 206) {
          if (!range || range.start !== bytes || range.total !== partial.total || range.end !== partial.total - 1 || etag !== partial.etag || finalUrl !== partial.finalUrl || mime !== partial.mime || encoded || announced !== undefined && announced !== range.end - range.start + 1) {
            throw new RetryableDownloadError("资源范围或校验标识变化，将重新下载", true);
          }
        } else {
          if (response.status === 206 && (!range || range.start !== 0 || range.end + 1 !== range.total || encoded || announced !== undefined && announced !== range.total)) throw new Error("资源响应不是完整范围");
          if (partial) await reset(); // A 200 response ignored Range or selected a new representation.
          const total = range?.total ?? announced;
          resume = total && etag && !encoded ? { total, etag, finalUrl, mime } : undefined;
        }
        const total = range?.total ?? announced;
        const offset = bytes;
        const fromPath = path.extname(new URL(sourceUrl).pathname).replace(/^\./, "").toLowerCase();
        const ext = assetExtension(mime ?? "", /^[a-z0-9]{1,8}$/.test(fromPath) ? fromPath : "bin");
        const relativePath = `${prefix}${ext}`;
        const target = await writableFile(root, relativePath);
        if (!handle) { temporary = await writableFile(root, `${relativePath}.part`); handle = await fs.open(temporary, "w"); }
        reader = response.body.getReader();
        deadline.addEventListener("abort", abortBody, { once: true });
        deadline.throwIfAborted();
        while (true) {
          const chunk = await reader.read();
          deadline.throwIfAborted();
          if (chunk.done) break;
          if (bytes + chunk.value.byteLength > maxBytes) throw new Error("文件超过保存上限");
          if (total !== undefined && bytes + chunk.value.byteLength > total) throw new Error("资源下载不完整（实际长度超过响应声明）");
          // FileHandle.write may complete only part of a buffer. Advance the hash and
          // resumable offset only after every byte of the chunk reaches the file.
          for (let written = 0; written < chunk.value.byteLength;) {
            deadline.throwIfAborted();
            const result = await handle.write(chunk.value, written, chunk.value.byteLength - written, bytes + written);
            if (!result.bytesWritten) throw new Error("资源文件写入未完成");
            written += result.bytesWritten;
          }
          hash.update(chunk.value); bytes += chunk.value.byteLength;
        }
        if (announced !== undefined && bytes - offset !== announced || total !== undefined && bytes !== total) throw new RetryableDownloadError("资源下载不完整（长度与响应声明不符）");
        if (!bytes) throw new Error("文件为空");
        if ((await handle.stat()).size !== bytes) throw new Error("资源文件写入长度不符");
        deadline.throwIfAborted();
        await handle.close(); handle = undefined;
        deadline.throwIfAborted();
        await atomicReplace(temporary!, target);
        return { id: relativeStem, role, status: "saved", path: relativePath, sourceUrl, bytes, sha256: hash.digest("hex"), mime, provenance: "original" };
      } catch (error) {
        deadline.removeEventListener("abort", abortBody);
        await reader?.cancel().catch(() => {});
        reader?.releaseLock(); reader = undefined;
        await response?.body?.cancel().catch(() => {});
        if (deadline.aborted || attempt + 1 >= DOWNLOAD_ATTEMPTS || !(error instanceof RetryableDownloadError || transientNetworkError(error))) throw error;
        if (error instanceof RetryableDownloadError && error.restart || !resume || bytes <= 0 || bytes >= resume.total) await reset();
        await retryPause(Math.max(250 * 3 ** attempt, error instanceof RetryableDownloadError ? error.delayMs ?? 0 : 0), deadline);
      } finally {
        deadline.removeEventListener("abort", abortBody);
        reader?.releaseLock();
      }
    }
    throw new Error("资源下载失败");
  } catch (error) {
    const reason = signal?.aborted ? "下载已取消" : deadline.aborted ? "资源下载超时" : error instanceof Error ? error.message : "资源下载失败";
    return { id: relativeStem, role, status: "failed", sourceUrl, provenance: "original", reason };
  } finally {
    await handle?.close().catch(() => {});
    if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export type ContentLoginPlatform = Extract<ContentPlatform, "xiaohongshu" | "bilibili" | "douyin" | "weibo" | "youtube">;
export async function openContentLogin(platform: ContentLoginPlatform, runtimeRoot: string): Promise<void> {
  const homes: Record<ContentLoginPlatform, string> = { xiaohongshu: "https://www.xiaohongshu.com/", bilibili: "https://www.bilibili.com/", douyin: "https://www.douyin.com/", weibo: "https://weibo.com/", youtube: "https://www.youtube.com/" };
  const home = homes[platform];
  if (!home) throw new Error("不支持此平台的专用登录");
  const youtubeProxy = platform === "youtube" ? (await (await import("./content-youtube-transport.js")).configuredYoutubeNetwork(runtimeRoot)).proxyUrl : undefined;
  const profile = path.resolve(runtimeRoot, ".content-profile", platform);
  await ensureDirectory(profile);
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, { executablePath: resolveEdgeExecutable(), headless: false, ...(platform === "youtube" ? youtubeProxy ? { proxy: { server: youtubeProxy } } : { args: ["--no-proxy-server"] } : {}) });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(home, { waitUntil: "domcontentloaded", timeout: 45_000 });
    let saving = Promise.resolve();
    const saveCookies = () => { saving = saving.catch(() => {}).then(async () => { if (platform !== "xiaohongshu" && context) await persistContentLoginCookies(runtimeRoot, platform, await context.cookies()); }); return saving; };
    await saveCookies();
    const timer = platform !== "xiaohongshu" ? setInterval(() => void saveCookies().catch(() => {}), 1_000) : undefined;
    try { await Promise.race([page.waitForEvent("close"), context.waitForEvent("close")]); await saveCookies().catch(() => {}); }
    finally { if (timer) clearInterval(timer); }
  } finally { await context?.close().catch(() => {}); }
}

type LoginCookie = { domain: string; path: string; secure: boolean; expires: number; name: string; value: string };
/** Writes only cookies belonging to the selected dedicated profile's own platform. */
export async function persistContentLoginCookies(runtimeRoot: string, platform: Exclude<ContentLoginPlatform, "xiaohongshu">, cookies: LoginCookie[]): Promise<boolean> {
  const domains = { bilibili: ["bilibili.com"], douyin: ["douyin.com", "iesdouyin.com"], weibo: ["weibo.com", "weibo.cn"], youtube: ["youtube.com"] }[platform];
  if (!domains) throw new Error("不支持此平台的 Cookie 保存");
  const valid = cookies.filter(cookie => {
    const domain = cookie.domain.toLowerCase().replace(/^\./, "");
    return domains.some(allowed => domain === allowed || domain.endsWith(`.${allowed}`))
      && /^[.a-z0-9-]+$/i.test(cookie.domain) && /^\/[^\x00-\x1f\x7f]*$/.test(cookie.path)
      && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(cookie.name) && !/[\x00-\x1f\x7f]/.test(cookie.value)
      && Number.isFinite(cookie.expires) && (cookie.expires <= 0 || cookie.expires > Date.now() / 1000);
  });
  if (!valid.length) return false;
  const rows = valid.map(cookie => [cookie.domain, cookie.domain.startsWith(".") ? "TRUE" : "FALSE", cookie.path, cookie.secure ? "TRUE" : "FALSE", String(cookie.expires > 0 ? Math.floor(cookie.expires) : 0), cookie.name, cookie.value].join("\t"));
  const profile = path.resolve(runtimeRoot, ".content-profile", platform);
  const target = await writableFile(profile, "cookies.txt");
  const temporary = await writableFile(profile, `cookies.${randomUUID()}.part`);
  try { await fs.writeFile(temporary, ["# Netscape HTTP Cookie File", ...rows].join("\n") + "\n", { mode: 0o600, flag: "wx" }); await atomicReplace(temporary, target); }
  finally { await fs.unlink(temporary).catch(() => {}); }
  return true;
}
/** Compatibility export for the existing Bilibili adapter. */
export async function persistBilibiliCookies(runtimeRoot: string, cookies: LoginCookie[]): Promise<boolean> {
  return persistContentLoginCookies(runtimeRoot, "bilibili", cookies);
}

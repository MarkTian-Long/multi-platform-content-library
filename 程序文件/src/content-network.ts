import { createHash } from "node:crypto";
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
import { fileHash, writableFile, atomicReplace } from "./content-library.js";

const MAX_REDIRECTS = 5;
const finalUrls = new WeakMap<Response, string>();
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
  try { await resolvePublicHost(host,signal); } catch (error) { if(signal?.aborted)throw signal.reason;if (error instanceof Error && error.message.includes("私网")) throw error; throw new Error("无法解析公网域名或解析超时"); }
  return url;
}

async function pinnedResponse(url: URL, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const resolved = await resolvePublicHost(url.hostname,signal);
  return new Promise<Response>((resolve, reject) => {
    const pinnedLookup = (_host: string, options: unknown, callback?: (...args: unknown[]) => void) => {
      const done = (typeof options === "function" ? options : callback) as ((...args: unknown[]) => void) | undefined;
      if ((options as { all?: boolean })?.all) done?.(null, [{ address: resolved.address, family: resolved.family }]);
      else done?.(null, resolved.address, resolved.family);
    };
    const request = (url.protocol === "https:" ? https : http).request(url, { method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers).entries()), signal: signal ?? init.signal ?? undefined, lookup: pinnedLookup as never, servername: url.hostname }, (incoming) => {
      const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      const encoding = headers.get("content-encoding")?.toLowerCase();
      const decoded = encoding === "gzip" ? incoming.pipe(createGunzip()) : encoding === "deflate" ? incoming.pipe(createInflate()) : encoding === "br" ? incoming.pipe(createBrotliDecompress()) : incoming;
      if(decoded!==incoming){incoming.once("error",error=>decoded.destroy(error));decoded.once("close",()=>incoming.destroy());}
      if (encoding) { headers.delete("content-encoding"); headers.delete("content-length"); }
      resolve(new Response(Readable.toWeb(decoded) as ReadableStream, { status: incoming.statusCode ?? 500, headers }));
    });
    request.once("error", reject); request.end();
  });
}

export async function fetchPublic(value: string | URL, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  signal=AbortSignal.any([AbortSignal.timeout(5*60000),...(signal?[signal]:init.signal?[init.signal]:[])]);
  let current = await publicHttpUrl(value,signal);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = globalThis.fetch === nativeFetch ? await pinnedResponse(current, init, signal) : await fetch(current, { ...init, redirect: "manual", signal: signal ?? init.signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (response.url) await publicHttpUrl(response.url);
      finalUrls.set(response, current.toString());
      return response;
    }
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => {});
    if (!location) throw new Error("重定向缺少目标地址");
    current = await publicHttpUrl(new URL(location, current),signal);
  }
  throw new Error("重定向次数过多");
}

/** Final redirect target recorded by fetchPublic; avoids persisting signed request URLs. */
export function fetchedPublicUrl(response: Response): string | undefined { return finalUrls.get(response) || response.url || undefined; }

function assetExtension(contentType: string, fallback = "bin"): string {
  const type = contentType.split(";", 1)[0].trim().toLowerCase();
  return ({ "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "video/mp4": "mp4", "video/webm": "webm", "text/vtt": "vtt", "application/pdf": "pdf" } as Record<string, string>)[type] ?? fallback;
}

export async function savePublicAsset(sourceUrl: string, directory: string, relativeStem: string, role: ContentAsset["role"], signal?: AbortSignal, maxBytes = 100 * 1024 * 1024, trusted?:ContentAsset): Promise<ContentAsset> {
  let response: Response | undefined;
  try {
    response = await fetchPublic(sourceUrl, {}, signal);
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const announced = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(announced) && announced > maxBytes) throw new Error("文件超过保存上限");
    const range = response.status === 206 ? /^bytes 0-(\d+)\/(\d+)$/i.exec(response.headers.get("content-range") ?? "") : undefined;
    if (response.status === 206 && (!range || Number(range[1]) + 1 !== Number(range[2]))) throw new Error("资源响应不是完整范围");
    const mime = response.headers.get("content-type") ?? undefined;
    if (/^text\/html\b/i.test(mime ?? "")) throw new Error("资源地址返回 HTML，可能要求登录或已失效");
    const fromPath = path.extname(new URL(sourceUrl).pathname).replace(/^\./, "").toLowerCase();
    const ext = assetExtension(response.headers.get("content-type") ?? "", /^[a-z0-9]{1,8}$/.test(fromPath) ? fromPath : "bin");
    const relativePath = `${relativeStem}.${ext}`.replaceAll("\\", "/");
    const root = await fs.realpath(directory);
    const target = await writableFile(root,relativePath);
    if (!isPathWithin(root, target)) throw new Error("资源路径超出资料目录");
    await fs.mkdir(path.dirname(target), { recursive: true });
    const realParent = await fs.realpath(path.dirname(target));
    if (!isPathWithin(root, realParent)) throw new Error("资源路径包含符号链接");
    try {
      const existing = await fs.lstat(target);
      if (existing.isSymbolicLink()) throw new Error("资源文件不能是符号链接");
      if (existing.isFile() && existing.size > 0 && trusted?.status==="saved" && trusted.sha256 && trusted.sourceUrl===sourceUrl && trusted.path===relativePath && existing.size===trusted.bytes && await fileHash(target)===trusted.sha256) { await response.body.cancel().catch(() => {}); return {...trusted,id:relativeStem,role,path:relativePath,sourceUrl,mime}; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = await writableFile(root,`${relativePath}.part`);
    try { if ((await fs.lstat(temporary)).isSymbolicLink()) throw new Error("临时资源文件不能是符号链接"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const handle = await fs.open(temporary, "w");
    const hash = createHash("sha256");
    let bytes = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      reader = response.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (signal?.aborted) throw new DOMException("已取消", "AbortError");
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) throw new Error("文件超过保存上限");
        hash.update(chunk.value);
        await handle.write(chunk.value);
      }
      if (!bytes) throw new Error("文件为空");
      if (Number.isFinite(announced) && announced > 0 && bytes !== announced) throw new Error("资源下载不完整（长度与响应声明不符）");
      if (range && bytes !== Number(range[2])) throw new Error("资源下载不完整（范围与实际长度不符）");
      await handle.close();
      await atomicReplace(temporary, target);
      return { id: relativeStem, role, status: "saved", path: relativePath, sourceUrl, bytes, sha256: hash.digest("hex"), mime, provenance: "original" };
    } catch (error) {
      await reader?.cancel().catch(() => {});
      await handle.close().catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  } catch (error) {
    await response?.body?.cancel().catch(() => {});
    const reason = signal?.aborted ? "下载已取消" : error instanceof Error ? error.message : "资源下载失败";
    return { id: relativeStem, role, status: "failed", sourceUrl, provenance: "original", reason };
  }
}

export async function openContentLogin(platform: Extract<ContentPlatform, "xiaohongshu" | "bilibili">, runtimeRoot: string): Promise<void> {
  const home = platform === "xiaohongshu" ? "https://www.xiaohongshu.com/" : "https://www.bilibili.com/";
  const profile = path.resolve(runtimeRoot, ".content-profile", platform);
  await fs.mkdir(profile, { recursive: true });
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, { executablePath: resolveEdgeExecutable(), headless: false });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(home, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const saveCookies = async () => { if (platform === "bilibili" && context) await persistBilibiliCookies(runtimeRoot, await context.cookies(["https://www.bilibili.com/"])); };
    await saveCookies();
    const timer = platform === "bilibili" ? setInterval(() => void saveCookies().catch(() => {}), 1_000) : undefined;
    try { await Promise.race([page.waitForEvent("close"), context.waitForEvent("close")]); await saveCookies(); }
    finally { if (timer) clearInterval(timer); }
  } finally { await context?.close().catch(() => {}); }
}

type LoginCookie = { domain: string; path: string; secure: boolean; expires: number; name: string; value: string };
/** Writes only the dedicated Bilibili profile cookies through a replace-on-success file. */
export async function persistBilibiliCookies(runtimeRoot: string, cookies: LoginCookie[]): Promise<boolean> {
  const profile = path.resolve(runtimeRoot, ".content-profile", "bilibili");
  await fs.mkdir(profile, { recursive: true });
  const rows = cookies.filter((cookie) => /(^|\.)bilibili\.com$/i.test(cookie.domain)).map((cookie) => [cookie.domain, cookie.domain.startsWith(".") ? "TRUE" : "FALSE", cookie.path, cookie.secure ? "TRUE" : "FALSE", String(cookie.expires > 0 ? Math.floor(cookie.expires) : 0), cookie.name, cookie.value].join("\t"));
  if (!rows.length) return false;
  const target = path.join(profile, "cookies.txt"); const temporary = `${target}.part`;
  await fs.writeFile(temporary, ["# Netscape HTTP Cookie File", ...rows].join("\n"), { mode: 0o600 });
  await fs.rename(temporary, target);
  return true;
}

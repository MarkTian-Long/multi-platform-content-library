import path from "node:path";
import { chromium, type BrowserContext, type Response as BrowserResponse } from "playwright-core";
import { ensureDirectory } from "./content-library.js";
import { publicHttpUrl } from "./content-network.js";
import { douyinWorkReference, weiboPostReference } from "./content-social-reference.js";
import { resolveEdgeExecutable } from "./url-policy.js";
import type { ContentContext, ContentInput } from "./content-types.js";

export interface SocialBrowserJsonRequest { url: string; method?: "GET" | "POST"; headers?: Record<string, string>; body?: string; }
export interface SocialBrowserSnapshot { finalUrl: string; html: string; responses: Array<{ url: string; data: unknown }>; gated: boolean; }
export class SocialBrowserError extends Error {
  constructor(message: string, readonly status: "unavailable" | "missing_dependency" = "unavailable") { super(message); }
}
interface SocialBrowserDeps {
  launch?: typeof chromium.launchPersistentContext;
  executable?: () => string;
  validateUrl?: typeof publicHttpUrl;
}
const activeProfiles = new Set<string>();
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_JSON_BYTES = 8 * 1024 * 1024;
const MAX_HTML_BYTES = 8 * 1024 * 1024;

/** Only normal, read-only platform APIs can be read or explicitly requested. */
export function socialBrowserJsonEndpoint(platform: ContentInput["platform"], value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    if (platform === "douyin") return url.hostname === "www.douyin.com" && url.pathname === "/aweme/v1/web/aweme/detail/";
    if (platform === "weibo") return ["weibo.com", "www.weibo.com"].includes(url.hostname) && ["/ajax/statuses/show", "/ajax/statuses/longtext", "/tv/api/component"].includes(url.pathname)
      || platform === "weibo" && url.hostname === "m.weibo.cn" && ["/statuses/show", "/statuses/extend", "/api/statuses/show", "/api/statuses/extend"].includes(url.pathname);
    return false;
  } catch { return false; }
}

function targetUrl(input: ContentInput): string {
  const reference = input.platform === "douyin" ? douyinWorkReference(input.canonicalUrl) : input.platform === "weibo" ? weiboPostReference(input.canonicalUrl) : undefined;
  if (!reference || !input.nativeId || reference.nativeId !== input.nativeId) throw new SocialBrowserError("Edge 采集缺少一致的单条作品或帖子身份");
  if (input.platform === "douyin") return `https://www.douyin.com/${reference.kind === "note" ? "note" : "video"}/${input.nativeId}`;
  const post = weiboPostReference(input.canonicalUrl)!;
  if (post.kind === "video") return `https://weibo.com/tv/show/${post.fid}`;
  const source = weiboPostReference(input.url);
  if (source?.nativeId === post.nativeId) { const url = new URL(input.url); return `https://${url.hostname}${url.pathname}`; }
  return post.canonicalUrl;
}

function permittedRequest(platform: ContentInput["platform"], request: SocialBrowserJsonRequest): boolean {
  if (!socialBrowserJsonEndpoint(platform, request.url) || request.body && Buffer.byteLength(request.body) > 16 * 1024) return false;
  const isTv = new URL(request.url).pathname === "/tv/api/component";
  if ((request.method ?? "GET") !== (isTv ? "POST" : "GET") || !isTv && request.body !== undefined) return false;
  return Object.keys(request.headers ?? {}).every(key => ["accept", "content-type"].includes(key.toLowerCase()));
}

/** Uses only the app-owned Edge profile. Raw DOM/API data stays in memory and is validated by the platform adapter. */
export async function captureSocialBrowser(input: ContentInput, context: ContentContext, requests: SocialBrowserJsonRequest[] = [], deps: SocialBrowserDeps = {}): Promise<SocialBrowserSnapshot> {
  context.signal?.throwIfAborted();
  const startUrl = targetUrl(input);
  if (requests.length > 6 || requests.some(request => !permittedRequest(input.platform, request))) throw new SocialBrowserError("Edge 只允许有限的官方读取接口请求");
  const profile = path.resolve(context.runtimeRoot, ".content-profile", input.platform);
  const profileKey = process.platform === "win32" ? profile.toLowerCase() : profile;
  if (activeProfiles.has(profileKey)) throw new SocialBrowserError("该平台的专用 Edge 采集正在进行，请稍后重试");
  activeProfiles.add(profileKey);
  const signal = AbortSignal.any([AbortSignal.timeout(65_000), ...(context.signal ? [context.signal] : [])]);
  const validate = deps.validateUrl ?? publicHttpUrl;
  let browser: BrowserContext | undefined;
  let stage = "公网地址检查";
  const responses: SocialBrowserSnapshot["responses"] = [];
  const pending = new Set<Promise<void>>();
  let notifyData: () => void = () => {};
  const dataReady = new Promise<void>(resolve => { notifyData = resolve; });
  let bytes = 0, claimed = 0;
  const collect = async (response: BrowserResponse): Promise<void> => {
    if (signal.aborted || response.status() !== 200 || !socialBrowserJsonEndpoint(input.platform, response.url()) || claimed >= 24) return;
    claimed++;
    try {
      const headers = await response.allHeaders();
      if (!/(?:application\/json|text\/json)/i.test(headers["content-type"] ?? "") || Number(headers["content-length"] ?? 0) > MAX_JSON_BYTES) return;
      const body = await response.body();
      if (signal.aborted || body.byteLength > MAX_JSON_BYTES || bytes + body.byteLength > MAX_TOTAL_JSON_BYTES) return;
      const data: unknown = JSON.parse(body.toString("utf8"));
      bytes += body.byteLength; responses.push({ url: response.url(), data });
      const value = data as { aweme_detail?: { aweme_id?: string }; mblogid?: string; data?: { mblogid?: string } } | null;
      if (input.platform === "douyin" && value?.aweme_detail?.aweme_id === input.nativeId || input.platform === "weibo" && (value?.mblogid === input.nativeId || value?.data?.mblogid === input.nativeId)) notifyData();
    } catch { /* Responses that are missing, oversized or not JSON cannot supply a target. */ }
  };
  const closeOnAbort = () => { void browser?.close().catch(() => {}); };
  signal.addEventListener("abort", closeOnAbort, { once: true });
  try {
    await validate(startUrl, signal);
    await ensureDirectory(profile);
    let executablePath: string;
    try { executablePath = (deps.executable ?? resolveEdgeExecutable)(); }
    catch { throw new SocialBrowserError("未找到可用的 Microsoft Edge，请检查本机 Edge 安装", "missing_dependency"); }
    context.onProgress?.(`正在通过专用${input.platform === "douyin" ? "抖音" : "微博"} Edge 会话加载目标页面`);
    stage = "启动浏览器";
    try { browser = await (deps.launch ?? chromium.launchPersistentContext.bind(chromium))(profile, { executablePath, headless: true, timeout: 25_000, serviceWorkers: "block", acceptDownloads: false }); }
    catch { signal.throwIfAborted(); throw new SocialBrowserError("专用 Edge 未能启动；若平台登录窗口仍打开，请关闭后重试"); }
    signal.throwIfAborted();
    const validHosts = new Map<string, Promise<unknown>>();
    await browser.route("**/*", async route => {
      try {
        const url = new URL(route.request().url());
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid route");
        let validation = validHosts.get(url.host);
        if (!validation) { validation = validate(url, signal); validHosts.set(url.host, validation); }
        await validation; signal.throwIfAborted(); await route.continue();
      } catch { await route.abort().catch(() => {}); }
    });
    const page = await browser.newPage();
    const onResponse = (response: BrowserResponse) => { const task = collect(response); pending.add(task); void task.finally(() => pending.delete(task)); };
    page.on("response", onResponse);
    stage = "加载目标页面";
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 35_000 });
    stage = "等待目标数据";
    await Promise.race([dataReady, page.waitForFunction(() => {
      // Weibo's normal visitor bootstrap briefly navigates through passport hosts.
      // Let it finish instead of treating an intermediary visitor page as a gate.
      if (/^\/(?:login|verify|captcha)(?:\/|$)/.test(location.pathname)) return true;
      return [...document.querySelectorAll(".captcha_verify_container,#captcha_container,iframe[src*=captcha]")].some(node => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; });
    }, undefined, { timeout: 8_000 }).catch(() => { signal.throwIfAborted(); })]);
    for (const request of requests) {
      stage = "读取官方接口";
      signal.throwIfAborted();
      const read = () => page.evaluate(async ({ request, maximum }) => {
        const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), 8_000);
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          const response = await fetch(request.url, { method: request.method ?? "GET", headers: request.headers, body: request.body, credentials: "include", redirect: "error", signal: deadline.signal });
          if (!response.ok || !response.body || Number(response.headers.get("content-length") ?? 0) > maximum) { await response.body?.cancel(); return undefined; }
          reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
          while (true) { const result = await reader.read(); if (result.done) break; length += result.value.byteLength; if (length > maximum) return undefined; chunks.push(result.value); }
          const joined = new Uint8Array(length); let position = 0;
          for (const chunk of chunks) { joined.set(chunk, position); position += chunk.byteLength; }
          return JSON.parse(new TextDecoder().decode(joined)) as unknown;
        } catch { return undefined; }
        finally { clearTimeout(timer); await reader?.cancel().catch(() => {}); }
      }, { request, maximum: MAX_JSON_BYTES });
      let data: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { data = await read(); break; }
        catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof Error) || !error.message.includes("Execution context was destroyed")) throw error;
          await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => { signal.throwIfAborted(); });
        }
      }
      if (data !== undefined) { const size = Buffer.byteLength(JSON.stringify(data)); if (bytes + size <= MAX_TOTAL_JSON_BYTES) { responses.push({ url: request.url, data }); bytes += size; } }
    }
    await Promise.allSettled([...pending]); signal.throwIfAborted();
    stage = "读取目标页面快照";
    const finalUrl = page.url(); await validate(finalUrl, signal);
    const html = await page.content();
    if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) throw new SocialBrowserError("平台渲染页面超过读取上限");
    const gated = await page.evaluate(() => {
      if (/^(?:visitor\.)?passport\./.test(location.hostname) || /^\/(?:login|passport|verify|captcha)(?:\/|$)/.test(location.pathname)) return true;
      const nodes = document.querySelectorAll(".captcha_verify_container,#captcha_container,[id^=captcha-],iframe[src*=captcha]");
      if ([...nodes].some(node => { const rect = node.getBoundingClientRect(), style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"; })) return true;
      return /^(?:请完成(?:安全|人机)?验证|请通过(?:安全|人机)?验证|扫码登录|请登录|登录后查看|访问过于频繁)/.test(document.body?.innerText.trim() ?? "");
    });
    page.off("response", onResponse);
    return { finalUrl, html, responses, gated };
  } catch (error) {
    context.signal?.throwIfAborted();
    if (signal.aborted) throw new SocialBrowserError("专用 Edge 页面读取超时，请稍后重试");
    if (error instanceof SocialBrowserError) throw error;
    const detail = error instanceof Error ? /net::ERR_[A-Z_]+|__name is not defined|Execution context was destroyed|Target page, context or browser has been closed/.exec(error.message)?.[0] : undefined;
    throw new SocialBrowserError(`专用 Edge 在${stage}时失败${detail ? `（${detail}）` : ""}，请稍后重试`);
  } finally {
    signal.removeEventListener("abort", closeOnAbort);
    await browser?.close().catch(() => {});
    activeProfiles.delete(profileKey);
  }
}

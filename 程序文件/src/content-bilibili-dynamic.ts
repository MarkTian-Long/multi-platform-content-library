import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type BrowserContext } from "playwright-core";
import { fetchPublic, fetchedPublicUrl, publicHttpUrl, savePublicAsset } from "./content-network.js";
import { atomicReplace, containedFile, ensureDirectory, fileHash, publicValue, writableFile } from "./content-library.js";
import { isPathWithin, resolveEdgeExecutable } from "./url-policy.js";
import type { CapturedContent, ContentAsset, ContentContext, ContentInput } from "./content-types.js";

export type BilibiliDynamicReference = { nativeId: string; dynamicId: string; canonicalUrl: string };
export interface BilibiliDynamicSnapshot { finalUrl: string; gated: boolean; responses: Array<{url: string; data: unknown}>; diagnostic?: string; }
export interface BilibiliDynamicDeps {
  requestJson?: (url: string, context: ContentContext) => Promise<unknown>;
  captureBrowser?: (input: ContentInput, context: ContentContext, requests: string[]) => Promise<BilibiliDynamicSnapshot>;
  saveAsset?: typeof savePublicAsset;
}
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {};
const str = (v: unknown): string => typeof v === "string" ? v : "";
const API_MAX = 4 * 1024 * 1024, IMAGE_MAX = 20 * 1024 * 1024, TOTAL_MAX = 100 * 1024 * 1024, MAX_IMAGES = 64;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";
class DynamicFailure extends Error { constructor(message: string, readonly status: ContentAsset["status"] = "unavailable") { super(message); } }

/** A dynamic and a video never share a native ID, even if their numeric IDs coincide. */
export function bilibiliDynamicReference(value: string): BilibiliDynamicReference | undefined {
  try {
    const u = new URL(value);
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password || u.port) return undefined;
    const p = u.pathname.replace(/\/$/, ""), host = u.hostname.toLowerCase();
    const id = host === "t.bilibili.com" ? /^\/([1-9]\d{0,21})$/.exec(p)?.[1] : ["www.bilibili.com", "bilibili.com"].includes(host) ? /^\/opus\/([1-9]\d{0,21})$/.exec(p)?.[1] : undefined;
    return id ? {nativeId: `dynamic:${id}`, dynamicId: id, canonicalUrl: `https://t.bilibili.com/${id}`} : undefined;
  } catch { return undefined; }
}
function apiUrl(id: string, opus = false): string { return `https://api.bilibili.com/x/polymer/web-dynamic/v1/${opus ? "opus/" : ""}detail?id=${id}`; }
function endpoint(value: string, id: string): "dynamic" | "opus" | undefined {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.hostname !== "api.bilibili.com" || u.username || u.password || u.port || u.searchParams.getAll("id").length !== 1 || u.searchParams.get("id") !== id) return undefined;
    return u.pathname === "/x/polymer/web-dynamic/v1/detail" ? "dynamic" : u.pathname === "/x/polymer/web-dynamic/v1/opus/detail" ? "opus" : undefined;
  } catch { return undefined; }
}
function exactItem(value: unknown, id: string, opus = false): Obj {
  const root = obj(value), item = obj(obj(root.data).item);
  if (root.code !== 0) throw new DynamicFailure(root.code === -352 || root.code === -101 || root.code === -111 ? "B 站官方接口需要登录或验证" : "B 站官方接口未返回目标动态", [-352, -101, -111].includes(Number(root.code)) ? "login_required" : "unavailable");
  if (item.id_str !== id || item.visible === false || opus && !Array.isArray(item.modules) || !opus && !["DYNAMIC_TYPE_WORD", "DYNAMIC_TYPE_DRAW", "DYNAMIC_TYPE_AV", "DYNAMIC_TYPE_FORWARD", "DYNAMIC_TYPE_ARTICLE"].includes(str(item.type))) throw new DynamicFailure("官方响应没有精确、可见的目标动态身份");
  if (opus && (item.modules as unknown[]).some(m => ["MODULE_TYPE_BLOCKED", "MODULE_TYPE_PAYWALL", "MODULE_TYPE_ITEM_NULL"].includes(str(obj(m).module_type)))) throw new DynamicFailure("目标图文被隐藏或受限，未读取付费/不可见内容", "login_required");
  return item;
}
async function boundedText(response: Response, signal?: AbortSignal): Promise<string> {
  if (Number(response.headers.get("content-length")) > API_MAX) { await response.body?.cancel(); throw new DynamicFailure("B 站接口正文超过读取上限"); }
  if (!response.body) throw new DynamicFailure("B 站接口没有正文");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { signal?.throwIfAborted(); const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > API_MAX) throw new DynamicFailure("B 站接口正文超过读取上限"); chunks.push(next.value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
async function requestJson(url: string, context: ContentContext): Promise<unknown> {
  const signal = AbortSignal.any([AbortSignal.timeout(15000), ...(context.signal ? [context.signal] : [])]);
  const response = await fetchPublic(url, {headers: {Accept: "application/json", "User-Agent": UA, Referer: "https://www.bilibili.com/"}}, signal);
  if (!endpoint(fetchedPublicUrl(response) || url, new URL(url).searchParams.get("id")!)) { await response.body?.cancel(); throw new DynamicFailure("B 站官方读取接口跳转到了无关来源"); }
  if (!response.ok) { await response.body?.cancel(); throw new DynamicFailure(`B 站官方接口返回 HTTP ${response.status}`, response.status === 403 || response.status === 401 ? "login_required" : "unavailable"); }
  try { return JSON.parse(await boundedText(response, signal)); } catch (error) { if (error instanceof DynamicFailure) throw error; signal.throwIfAborted(); throw new DynamicFailure("B 站官方接口未返回有效 JSON"); }
}

/** Every fallback starts with an empty, temporary Edge profile; no user or saved login cookies are imported. */
export async function captureBilibiliDynamicBrowser(input: ContentInput, context: ContentContext, requests: string[]): Promise<BilibiliDynamicSnapshot> {
  const reference = bilibiliDynamicReference(input.url)!;
  if (!reference || requests.length > 2 || requests.some(u => !endpoint(u, reference.dynamicId))) throw new DynamicFailure("B 站浏览器读取请求不在目标接口范围内");
  const signal = AbortSignal.any([AbortSignal.timeout(65000), ...(context.signal ? [context.signal] : [])]);
  const profileRoot = path.resolve(context.runtimeRoot, ".content-profile", "bilibili-dynamic-transient");
  let profile: string | undefined, browser: BrowserContext | undefined;
  const closeOnAbort = () => { void browser?.close().catch(() => {}); };
  signal.addEventListener("abort", closeOnAbort, {once: true});
  try {
    await publicHttpUrl(input.url, signal); await ensureDirectory(profileRoot);
    profile = await fs.mkdtemp(path.join(profileRoot, "capture-"));
    let executablePath: string; try { executablePath = resolveEdgeExecutable(); } catch { throw new DynamicFailure("未找到 Microsoft Edge，无法读取 B 站动态", "missing_dependency"); }
    context.onProgress?.("通过独立空 Edge 会话读取目标 B 站动态");
    browser = await chromium.launchPersistentContext(profile, {executablePath, headless: true, serviceWorkers: "block", acceptDownloads: false, timeout: 25000});
    signal.throwIfAborted();
    const hosts = new Map<string, Promise<unknown>>();
    await browser.route("**/*", async route => {
      try {
        const u = new URL(route.request().url()); if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) throw new Error("invalid route");
        let check = hosts.get(u.host); if (!check) { check = publicHttpUrl(u, signal); hosts.set(u.host, check); }
        await check; signal.throwIfAborted(); await route.continue();
      } catch { await route.abort().catch(() => {}); }
    });
    const page = await browser.newPage(), responses: BilibiliDynamicSnapshot["responses"] = [], pending = new Set<Promise<void>>();
    let bytes = 0, claimed = 0;
    page.on("response", response => {
      if (signal.aborted || response.status() !== 200 || !endpoint(response.url(), reference.dynamicId) || claimed >= 12) return;
      claimed++;
      const task = (async () => { try {
        const headers = await response.allHeaders(); if (Number(headers["content-length"]) > API_MAX || !/json/i.test(headers["content-type"] || "")) return;
        const body = await response.body(); if (signal.aborted || body.byteLength > API_MAX || bytes + body.byteLength > 16 * 1024 * 1024) return;
        bytes += body.byteLength; responses.push({url: response.url(), data: JSON.parse(body.toString("utf8"))});
      } catch { /* Missing or bounded-out responses cannot supply the target. */ } })();
      pending.add(task); void task.finally(() => pending.delete(task));
    });
    await page.goto(input.url, {waitUntil: "domcontentloaded", timeout: 35000});
    // The anonymous visitor bootstrap sets only this empty profile's own session.
    // Direct official reads work even when the page's signed request is risk-controlled.
    await page.waitForFunction(() => /(?:^|;\s*)buvid3=/.test(document.cookie), undefined, {timeout: 4000}).catch(() => { signal.throwIfAborted(); });
    const requested = await page.evaluate(async ({urls, maximum}) => {
      const results: Array<{url: string; data: unknown}> = [], diagnostics: string[] = [];
      for (const url of urls) { try {
        const response = await fetch(url, {credentials: "include"});
        if (response.status !== 200 || Number(response.headers.get("content-length")) > maximum || !response.body) { await response.body?.cancel(); continue; }
        const reader = response.body.getReader(), decoder = new TextDecoder(); let text = "", bytes = 0;
        try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > maximum) throw new Error("bounded response"); text += decoder.decode(next.value, {stream: true}); } text += decoder.decode(); }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const data = JSON.parse(text); results.push({url: response.url, data}); diagnostics.push(`HTTP ${response.status}; code=${String(data?.code)}`);
      } catch (error) { diagnostics.push(error instanceof Error ? error.message : "official request failed"); } }
      return {results, diagnostics};
    }, {urls: requests, maximum: API_MAX});
    responses.push(...requested.results);
    await Promise.all([...pending]); signal.throwIfAborted();
    const gated = await page.evaluate(() => !!document.querySelector(".geetest_panel,.geetest_holder,.bili-login-panel") || /扫码登录|账号.*密码.*忘记密码/s.test(document.body.innerText));
    return {finalUrl: page.url(), gated, responses, diagnostic: requested.diagnostics.join("; ")};
  } finally {
    signal.removeEventListener("abort", closeOnAbort); await browser?.close().catch(() => {});
    if (profile && path.dirname(path.resolve(profile)) === profileRoot && path.basename(profile).startsWith("capture-")) await fs.rm(profile, {recursive: true, force: true}).catch(() => {});
  }
}
type ParsedOpus = {text: string; images: string[]; title: string; author: Obj; partial: boolean};
function parseOpus(item: Obj): ParsedOpus {
  const modules = (item.modules as unknown[]).map(obj), images: string[] = [], lines: string[] = []; let partial = false;
  const addPics = (value: unknown) => { if (Array.isArray(value)) for (const p of value) { const u = str(obj(p).url) || str(obj(p).src); if (u) images.push(u); else partial = true; } };
  const words = (value: unknown): string => {
    const nodes = obj(value).nodes; if (!Array.isArray(nodes)) { partial = true; return ""; }
    return nodes.map(n => {
      const node = obj(n);
      const value = node.type === "TEXT_NODE_TYPE_WORD" ? obj(node.word).words : node.type === "TEXT_NODE_TYPE_RICH" ? obj(node.rich).text : node.type === "TEXT_NODE_TYPE_USER" ? obj(node.user).name : undefined;
      if (typeof value === "string") return value;
      partial = true; return "";
    }).join("");
  };
  for (const module of modules) {
    if (module.module_type === "MODULE_TYPE_TOP") addPics(obj(obj(obj(module.module_top).display).album).pics);
    if (module.module_type !== "MODULE_TYPE_CONTENT") continue;
    const paragraphs = obj(module.module_content).paragraphs;
    if (!Array.isArray(paragraphs) || paragraphs.length > 5000) throw new DynamicFailure("B 站图文段落缺失或超过读取上限");
    for (const raw of paragraphs) {
      const p = obj(raw);
      if (p.para_type === 1 && p.text) lines.push(words(p.text));
      else if (p.para_type === 2 && p.pic) addPics(obj(p.pic).pics);
      else if (p.para_type === 3 && p.line) lines.push("---");
      else if (p.para_type === 6 && p.link_card) { /* Interactive cards are not original prose or media. */ }
      else partial = true;
    }
  }
  const title = str(obj(modules.find(m => m.module_type === "MODULE_TYPE_TITLE")?.module_title).text);
  const author = obj(modules.find(m => m.module_type === "MODULE_TYPE_AUTHOR")?.module_author);
  return {text: lines.join("\n\n").trim(), images, title, author, partial};
}
function videoReference(archive: Obj): {url: string; title: string} | undefined {
  const bvid = str(archive.bvid); if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return undefined;
  const url = `https://www.bilibili.com/video/${bvid}/`, raw = str(archive.jump_url);
  if (raw) { try { const u = new URL(raw, "https://www.bilibili.com"); if (u.protocol !== "https:" || u.username || u.password || u.port || !["bilibili.com", "www.bilibili.com"].includes(u.hostname) || u.pathname.replace(/\/$/, "") !== `/video/${bvid}`) return undefined; } catch { return undefined; } }
  return {url, title: str(archive.title) || bvid};
}
async function saveImage(url: string, stem: string, role: "image" | "cover", context: ContentContext, deps: BilibiliDynamicDeps, maximum: number): Promise<ContentAsset> {
  let transaction: string | undefined; const root = path.resolve(context.directory);
  try {
    await publicHttpUrl(url, context.signal);
    transaction = path.dirname(await writableFile(root, `.bilibili-dynamic-downloads/${randomUUID()}/transaction`));
    const asset = await (deps.saveAsset ?? savePublicAsset)(url, transaction, "image", role, context.signal, maximum);
    if (asset.status !== "saved" || !asset.path) return {...asset, id: stem, path: undefined, sourceUrl: undefined, provenance: "original"};
    const file = await containedFile(transaction, asset.path), stat = await fs.stat(file);
    if (!stat.size || stat.size > maximum || asset.bytes !== stat.size || !asset.sha256 || await fileHash(file) !== asset.sha256) throw new DynamicFailure("B 站原图未通过实际字节和哈希核验", "failed");
    const handle = await fs.open(file, "r"); const header = Buffer.alloc(16); try { await handle.read(header, 0, 16, 0); } finally { await handle.close(); }
    const mime = header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png" : header[0] === 255 && header[1] === 216 && header[2] === 255 ? "image/jpeg" : /^GIF8[79]a/.test(header.toString("ascii")) ? "image/gif" : header.toString("ascii",0,4) === "RIFF" && header.toString("ascii",8,12) === "WEBP" ? "image/webp" : undefined;
    if (!mime || asset.mime !== mime) throw new DynamicFailure("B 站图片响应不是有效原图，未替换已有文件", "failed");
    const relative = `${stem}.${mime === "image/jpeg" ? "jpg" : mime.split("/")[1]}`;
    context.signal?.throwIfAborted(); await atomicReplace(file, await writableFile(root, relative));
    return {id: stem, role, status: "saved", path: relative, capturePath: relative, bytes: stat.size, sha256: asset.sha256, mime, provenance: "original"};
  } catch (error) {
    if (context.signal?.aborted) throw error;
    return {id: stem, role, status: "failed", provenance: "original", reason: publicValue(error instanceof Error ? error.message : "B 站原图未保存")};
  } finally {
    if (transaction && path.dirname(transaction) === path.join(root, ".bilibili-dynamic-downloads") && isPathWithin(root, transaction)) await fs.rm(transaction, {recursive: true, force: true}).catch(() => {});
  }
}

/** Exact original dynamic prose/images and bound video references. Does not expand forwards or download a multi-hour linked video implicitly. */
export async function acquireBilibiliDynamic(input: ContentInput, context: ContentContext, deps: BilibiliDynamicDeps = {}): Promise<CapturedContent> {
  const record: CapturedContent = {platform: "bilibili", nativeId: input.nativeId, sourceUrl: input.url, canonicalUrl: input.canonicalUrl, title: "B 站动态", capturedAt: new Date().toISOString(), kind: "article", markdown: "", assets: [], warnings: [], coverage: {body: "unknown", media: "not_attempted", comments: "not_attempted"}};
  const signal = AbortSignal.any([AbortSignal.timeout(120000), ...(context.signal ? [context.signal] : [])]), current = {...context, signal};
  const checkpoint = async () => { await current.onCheckpoint?.(record); };
  try {
    signal.throwIfAborted();
    const raw = bilibiliDynamicReference(input.url), canonical = bilibiliDynamicReference(input.canonicalUrl), ref = raw ?? canonical;
    let short = false; try { const u = new URL(input.url); short = ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && !u.port && ["b23.tv", "www.b23.tv"].includes(u.hostname) && /^\/[0-9A-Za-z]{1,32}\/?$/.test(u.pathname); } catch {}
    if (input.platform !== "bilibili" || !ref || !canonical || !raw && !short || raw && canonical.nativeId !== raw.nativeId || input.nativeId && input.nativeId !== ref.nativeId) throw new DynamicFailure("输入不是一致的 B 站目标动态身份");
    record.nativeId = ref.nativeId; record.canonicalUrl = ref.canonicalUrl;
    const requests = [apiUrl(ref.dynamicId), apiUrl(ref.dynamicId, true)], request = deps.requestJson ?? requestJson;
    let dynamic: Obj | undefined, opus: Obj | undefined, snapshot: BilibiliDynamicSnapshot | undefined;
    const readBrowser = async () => {
      if (snapshot) return;
      snapshot = await (deps.captureBrowser ?? captureBilibiliDynamicBrowser)({...input, url: raw ? input.url : input.canonicalUrl}, current, requests); signal.throwIfAborted();
      if (bilibiliDynamicReference(snapshot.finalUrl)?.nativeId !== ref.nativeId) throw new DynamicFailure("B 站独立 Edge 页面的动态身份与输入不一致");
      for (const response of snapshot.responses.slice(0, 12)) {
        const source = endpoint(response.url, ref.dynamicId); if (!source) continue;
        try { const item = exactItem(response.data, ref.dynamicId, source === "opus"); if (source === "dynamic") dynamic = item; else opus = item; } catch { /* Other IDs, gates and non-target responses do not supply content. */ }
      }
      if (dynamic || opus) record.coverage!.acquisition = "saved: empty dedicated Edge official JSON";
      else if (snapshot.diagnostic) record.coverage!.acquisition = `unavailable: ${publicValue(snapshot.diagnostic).slice(0, 1000)}`;
    };
    current.onProgress?.("读取 B 站目标动态的官方正文与媒体身份");
    try { dynamic = exactItem(await request(requests[0], current), ref.dynamicId); } catch { signal.throwIfAborted(); }
    if (!dynamic) await readBrowser();
    const fields = obj(obj(dynamic?.modules).module_dynamic), major = obj(fields.major), forwarded = dynamic?.type === "DYNAMIC_TYPE_FORWARD";
    const needsOpus = !forwarded && (major.type === "MAJOR_TYPE_OPUS" || !str(obj(fields.desc).text) && dynamic?.type !== "DYNAMIC_TYPE_AV" || !dynamic);
    if (needsOpus && !opus) {
      try { opus = exactItem(await request(requests[1], current), ref.dynamicId, true); } catch { signal.throwIfAborted(); }
      if (!opus) await readBrowser();
    }
    if (!dynamic && !opus) throw new DynamicFailure(snapshot?.gated ? "B 站目标动态需要登录或验证，未取得精确原文" : "本轮未取得精确目标动态，未选取推荐或其他动态", snapshot?.gated ? "login_required" : "unavailable");
    let body = str(obj(fields.desc).text), pictures: string[] = [], partial = false, author = obj(obj(dynamic?.modules).module_author);
    if (forwarded) record.coverage!.forward = "excluded: forwarded original body/media";
    else {
      const draw = obj(major.draw), preview = obj(major.opus);
      for (const raw of [...(Array.isArray(draw.items) ? draw.items : []), ...(Array.isArray(preview.pics) ? preview.pics : [])]) pictures.push(str(obj(raw).src) || str(obj(raw).url));
      if (opus) { const parsed = parseOpus(opus); body = parsed.text; pictures.push(...parsed.images); partial = parsed.partial; if (Object.keys(parsed.author).length) author = parsed.author; if (parsed.title) record.title = parsed.title; }
      else if (needsOpus) { partial = true; if (!body) body = str(obj(preview.summary).text); }
    }
    if (Buffer.byteLength(body, "utf8") > API_MAX) throw new DynamicFailure("B 站动态正文超过保存上限，未截断冒充全文");
    record.markdown = body; record.author = str(author.name) || undefined;
    const timestamp = Number(author.pub_ts); if (Number.isFinite(timestamp) && timestamp > 0 && timestamp < 8640000000000) record.publishedAt = new Date(timestamp * 1000).toISOString();
    record.coverage!.body = body ? partial ? "partial: available original text; full opus/paragraph coverage not verified" : opus ? "saved: original opus text; interactive cards excluded" : "saved: original dynamic text" : "unavailable: no original dynamic text";
    record.coverage!.identity = `verified: dynamic:${ref.dynamicId}`;
    if (partial) record.warnings.push("动态只保存本轮可核对的原文；图文全文或部分段落未取得，不标为完整正文");
    if (!forwarded && dynamic?.type === "DYNAMIC_TYPE_AV") {
      const archive = obj(major.archive), video = videoReference(archive); record.kind = "video";
      if (video) {
        record.title = video.title; record.markdown = [body, `原动态关联视频：[${video.title.replace(/[\\[\]]/g, "\\$&")}](${video.url})`].filter(Boolean).join("\n\n");
        record.coverage!.videoReference = `verified: ${str(archive.bvid)}; original video link only`;
        record.assets.push({id: "bilibili-dynamic-video", role: "video", status: "unavailable", reason: `原动态关联 ${str(archive.bvid)}；原视频需按视频链接独立采集`, provenance: "original"});
      } else { record.coverage!.videoReference = "unavailable: missing/conflicting original BVID"; record.warnings.push("原动态视频卡片没有一致的 BVID 绑定证据"); }
      const cover = str(archive.cover);
      if (video && cover) { const asset = await saveImage(cover, "covers/001", "cover", current, deps, IMAGE_MAX); record.assets.push(asset); await checkpoint(); }
    }
    if (!forwarded && dynamic?.type === "DYNAMIC_TYPE_ARTICLE" && !opus) {
      record.coverage!.articleReference = "unavailable: article card is a summary, not the original article body";
      record.warnings.push("该动态引用专栏文章，卡片摘要没有作为图文全文保存");
    }
    pictures = [...new Set(pictures)]; if (pictures.length) record.kind = "gallery";
    if (record.title === "B 站动态" && body) record.title = Array.from(body.split(/\r?\n/)[0].trim()).slice(0, 160).join("") || record.title;
    await checkpoint(); let used = 0, saved = 0;
    for (const [i, url] of pictures.slice(0, MAX_IMAGES).entries()) {
      signal.throwIfAborted(); const stem = `images/${String(i + 1).padStart(3, "0")}`;
      const asset = TOTAL_MAX > used ? await saveImage(url, stem, "image", current, deps, Math.min(IMAGE_MAX, TOTAL_MAX - used)) : {id: stem, role: "image" as const, status: "skipped" as const, reason: "B 站动态原图总预算已用完", provenance: "original" as const};
      record.assets.push(asset);
      if (asset.status === "saved") { used += asset.bytes!; saved++; record.markdown += `${record.markdown ? "\n\n" : ""}![原图 ${i + 1}](${asset.path})`; }
      await checkpoint();
    }
    if (pictures.length > MAX_IMAGES) { record.assets.push({id: "bilibili-dynamic-images-missing", role: "image", status: "unavailable", reason: "动态原图超过 64 张数量上限", provenance: "original"}); record.warnings.push("部分原图超过本轮上限，未标全量取得"); }
    record.coverage!.images = pictures.length ? saved === pictures.length ? `saved: ${saved} verified original images` : `partial: ${saved}/${pictures.length} original images` : "not_applicable: no original images";
    record.coverage!.media = record.assets.some(a => a.status !== "saved") ? "partial: original media/reference coverage incomplete" : `saved: ${record.assets.length} verified original assets`;
    await checkpoint(); return record;
  } catch (error) {
    const reason = context.signal?.aborted ? "动态采集已取消；已核验保存的原图保留" : signal.aborted ? "B 站动态采集超时；已核验保存的原图保留" : publicValue(error instanceof Error ? error.message : "B 站动态采集未完成");
    record.assets.push({id: "bilibili-dynamic-acquisition", role: "source", status: signal.aborted ? "unavailable" : error instanceof DynamicFailure ? error.status : "failed", reason, provenance: "generated"});
    record.coverage!.media = signal.aborted ? "cancelled" : "unavailable"; record.warnings.push(reason); await context.onCheckpoint?.(record); return record;
  }
}

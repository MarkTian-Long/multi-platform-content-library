import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { load } from "cheerio";
import TurndownService from "turndown";
import { chromium } from "playwright-core";
import { resolveEdgeExecutable, isPathWithin } from "./url-policy.js";
import { fetchPublic, savePublicAsset, publicHttpUrl } from "./content-network.js";
import { runContentTool } from "./content-tools.js";
import type { CapturedContent, ContentAsset, ContentContext, ContentInput, ContentPart } from "./content-types.js";
import { writableFile,atomicReplace } from "./content-library.js";

export { openContentLogin } from "./content-network.js";

export interface ToolRunResult { code: number; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean; outputTruncated: boolean; }
export interface XiaohongshuSnapshot { finalUrl: string; title: string; author?: string; body: string; images: string[]; recommendedImages?: string[]; videos: string[]; }
export interface MediaProbe { video: boolean; audio: boolean; durationSeconds?: number; }
export interface AcquisitionDeps {
  runTool?: (command: string, args: string[], context: ContentContext) => Promise<ToolRunResult>;
  ytDlpPath?: string;
  captureXiaohongshu?: (input: ContentInput, context: ContentContext) => Promise<XiaohongshuSnapshot>;
  probeMedia?: (file: string, context: ContentContext) => Promise<MediaProbe | undefined>;
}
const BILIBILI_MAX_PARTS = 50;
const BILIBILI_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const BILIBILI_MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;

function capturedBase(input: ContentInput, kind: CapturedContent["kind"]): CapturedContent {
  return { platform: input.platform, nativeId: input.nativeId, sourceUrl: input.url, canonicalUrl: input.canonicalUrl, title: "未命名资料", capturedAt: new Date().toISOString(), kind, markdown: "", assets: [], warnings: [], coverage: {} };
}
async function checkpoint(context: ContentContext, record: CapturedContent): Promise<void> { await context.onCheckpoint?.(record); }

function safeTitle(value: string | undefined): string { return value?.replace(/\s+/g, " ").trim().slice(0, 240) || "未命名资料"; }
function publicMessage(error: unknown): string {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "采集失败";
  return message.replace(/https?:\/\/[^\s)]+/giu, (value) => { try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return "链接"; } });
}
function cleanUrl(value: string, base: string): string | undefined {
  if (!value.trim()) return undefined;
  try {
    const url = new URL(value, base);
    return /^(https?):$/i.test(url.protocol) && !url.username && !url.password ? url.toString() : undefined;
  } catch { return undefined; }
}
function cleanDom(html: string, source: string): { title: string; author?: string; markdown: string; images: string[] } {
  const $ = load(html);
  $("script,style,noscript,iframe,form,svg,canvas,object,embed,nav,footer,aside,[role=navigation],[role=complementary]").remove();
  $("*").each((_, node) => {
    const attributes = (node as unknown as { attribs?: Record<string, string> }).attribs ?? {};
    for (const [name, value] of Object.entries(attributes)) {
      if (name.toLowerCase().startsWith("on") || (name.toLowerCase() === "style" && /url\s*\(/i.test(value))) $(node).removeAttr(name);
    }
  });
  $("a").each((_, node) => {
    const href = cleanUrl($(node).attr("href") ?? "", source);
    if (href) $(node).attr("href", href); else $(node).replaceWith($(node).text());
  });
  const body = $("article,main,[role=main],.article,.content").filter((_, node) => $(node).text().trim().length > 0).first();
  const content = body.length ? body : $("body");
  const images: string[] = [];
  content.find("img").each((_, node) => {
    const sourceUrl = ["data-src", "data-original", "src"].map((name) => $(node).attr(name) ?? "").map((value) => cleanUrl(value, source)).find((value): value is string => !!value);
    if (!sourceUrl) { $(node).remove(); return; }
    images.push(sourceUrl);
    $(node).attr("src", `images/${String(images.length).padStart(3, "0")}.bin`).removeAttr("data-src").removeAttr("data-original");
  });
  const service = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });
  return { title: safeTitle($("h1").first().text() || $("title").first().text()), author: $("meta[name=author]").attr("content")?.trim() || undefined, markdown: service.turndown(content.html() ?? "").replace(/\n{3,}/g, "\n\n").trim(), images };
}

async function boundedHtml(response: Response, signal?: AbortSignal, maximum = 8 * 1024 * 1024): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > maximum) { await response.body?.cancel().catch(() => {}); throw new Error("网页正文超过保存上限"); }
  if (!response.body) return "";
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) { const item = await reader.read(); if (item.done) break; if (signal?.aborted) throw new DOMException("已取消", "AbortError"); bytes += item.value.byteLength; if (bytes > maximum) throw new Error("网页正文超过保存上限"); chunks.push(item.value); }
  } finally { await reader.cancel().catch(() => {}); }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function acquireWeb(input: ContentInput, context: ContentContext): Promise<CapturedContent> {
  const content = capturedBase(input, "article");
  context.onProgress?.("正在获取网页正文");
  let response: Response;
  try { response = await fetchPublic(input.url, { headers: { Accept: "text/html,application/xhtml+xml" } }, context.signal); }
  catch (error) { content.warnings.push(publicMessage(error)); content.coverage!.body = "failed"; await checkpoint(context, content); return content; }
  if (!response.ok) { content.warnings.push(`网页返回 HTTP ${response.status}`); content.coverage!.body = "failed"; return content; }
  let html: string;
  try { html = await boundedHtml(response, context.signal); } catch (error) { content.warnings.push(publicMessage(error)); content.coverage!.body = "failed"; await checkpoint(context, content); return content; }
  const parsed = cleanDom(html, input.url);
  content.title = parsed.title;
  content.author = parsed.author;
  content.markdown = parsed.markdown;
  content.coverage!.body = parsed.markdown ? "saved" : "unavailable: no readable body";
  if (loginPage(parsed.markdown)) { content.assets.push({ id: "login", role: "source", status: "login_required", reason: "网页要求登录或验证" }); content.coverage!.body = "login_required"; }
  await checkpoint(context, content);
  for (const [offset, sourceUrl] of parsed.images.entries()) {
    const stem=`images/${String(offset + 1).padStart(3, "0")}`;
    const asset = await savePublicAsset(sourceUrl, context.directory, stem, "image", context.signal, 25 * 1024 * 1024,context.existing?.assets.find(a=>a.id===stem));
    // Turndown is created before MIME sniffing; correct links after the asset is stored.
    if (asset.status === "saved" && asset.path) content.markdown = content.markdown.replace(`images/${String(offset + 1).padStart(3, "0")}.bin`, asset.path);
    content.assets.push(asset);
    await checkpoint(context, content);
  }
  return content;
}

function loginPage(text: string): boolean { return /^(请登录|登录后查看|请完成验证)|扫码登录|安全验证|人机验证|滑块/i.test(text.trim()); }

/** Reads one explicit rendered Xiaohongshu note subtree. Missing or ambiguous roots are unavailable, never the page main/body. */
export function extractXiaohongshuNoteHtml(html: string, finalUrl: string): XiaohongshuSnapshot {
  const $ = load(html);
  const raw = $("#noteContainer,.note-container,.note-detail-mask,[data-note-id]").filter((_, node) => !$(node).closest("[class*=recommend],[class*=related],[data-testid*=recommend]").length);
  const candidates = raw.filter((_, node) => !raw.toArray().some((other) => other !== node && $(node).find(other).length > 0));
  if (candidates.length !== 1) return { finalUrl, title: "", body: "", images: [], videos: [] };
  const root = candidates.first();
  const insideNote = (node: Parameters<typeof root.find>[0] extends never ? never : unknown): boolean => !$(node as never).closest("[class*=recommend],[class*=related],[data-testid*=recommend]").length;
  const text = (selector: string) => root.find(selector).first().text().trim();
  const bodyRoot = root.find(".note-content,.content,.desc,[data-testid=note-content]").first().clone(); bodyRoot.find(".recommend,.related,.comments,.author,[data-testid*=recommend]").remove();
  const images = [...root.find(".note-media img,[data-testid*=media] img").toArray(), ...root.children("img").toArray()].filter(insideNote).map((node) => $(node).attr("data-src") || $(node).attr("data-original") || $(node).attr("src") || "").map((url) => cleanUrl(url, finalUrl)).filter((url): url is string => !!url);
  const videos = root.find("video").toArray().filter(insideNote).map((node) => $(node).attr("src") || "").map((url) => cleanUrl(url, finalUrl)).filter((url): url is string => !!url);
  return { finalUrl, title: text("h1,.title"), author: text(".author,.user-name,[data-testid=author]") || undefined, body: bodyRoot.text().trim(), images, videos };
}

async function acquireXiaohongshu(input: ContentInput, context: ContentContext, deps: AcquisitionDeps): Promise<CapturedContent> {
  const content = capturedBase(input, "gallery");
  const profile = path.resolve(context.runtimeRoot, ".content-profile", "xiaohongshu");
  let browser: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    let snapshot: XiaohongshuSnapshot;
    if (deps.captureXiaohongshu) snapshot = await deps.captureXiaohongshu(input, context);
    else {
      await fs.mkdir(profile, { recursive: true });
      browser = await chromium.launchPersistentContext(profile, { executablePath: resolveEdgeExecutable(), headless: false });
      const page = browser.pages()[0] ?? await browser.newPage();
      await browser.route("**/*", async (route) => { try { await publicHttpUrl(route.request().url()); await route.continue(); } catch { await route.abort(); } });
      const closeOnAbort = () => void browser?.close(); context.signal?.addEventListener("abort", closeOnAbort, { once: true });
      context.onProgress?.("正在通过专用小红书 Edge 会话加载笔记主体");
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45_000 }); await page.waitForTimeout(1_500); await publicHttpUrl(page.url());
      const renderedHtml = await page.content();
      snapshot = extractXiaohongshuNoteHtml(renderedHtml, page.url());
      if (loginPage(await page.locator("body").innerText())) snapshot = { ...snapshot, body: "请登录或完成验证" };
      context.signal?.removeEventListener("abort", closeOnAbort);
    }
    await publicHttpUrl(snapshot.finalUrl);
    if (loginPage(snapshot.body)) {
      content.title = safeTitle(snapshot.title); content.warnings.push("页面要求登录或验证；请使用“登录平台”入口完成登录后重试"); content.assets.push({ id: "login", role: "source", status: "login_required", reason: "登录或验证码页面" }); content.coverage!.body = "login_required"; await checkpoint(context, content); return content;
    }
    content.title = safeTitle(snapshot.title);
    content.author = snapshot.author;
    content.markdown = snapshot.body.trim();
    content.kind = snapshot.videos.length ? "video" : "gallery";
    content.coverage!.body = content.markdown ? "saved: rendered text" : "unavailable: rendered body empty";
    await checkpoint(context, content);
    for (const [offset, sourceUrl] of snapshot.images.entries()) {const stem=`images/${String(offset + 1).padStart(3, "0")}`;content.assets.push(await savePublicAsset(sourceUrl, context.directory, stem, "image", context.signal, 25 * 1024 * 1024,context.existing?.assets.find(a=>a.id===stem))); await checkpoint(context, content); }
    for (const [offset, sourceUrl] of snapshot.videos.entries()) {const stem=`video/${String(offset + 1).padStart(3, "0")}`;content.assets.push(await savePublicAsset(sourceUrl, context.directory, stem, "video", context.signal,100*1024*1024,context.existing?.assets.find(a=>a.id===stem))); await checkpoint(context, content); }
    return content;
  } catch (error) { content.warnings.push(publicMessage(error)); content.coverage!.body = "failed"; await checkpoint(context, content); return content; }
  finally { await browser?.close().catch(() => {}); }
}

async function executable(runtimeRoot: string, names = process.platform === "win32" ? ["yt-dlp.exe", "yt-dlp"] : ["yt-dlp"]): Promise<string | undefined> {
  const candidates = names.map((name) => path.join(runtimeRoot, "tools", name));
  for (const candidate of candidates) try { await fs.access(candidate); return candidate; } catch { /* next */ }
  for (const folder of (process.env.PATH ?? "").split(path.delimiter)) for (const file of names) {
    const candidate = path.join(folder, file); try { await fs.access(candidate); return candidate; } catch { /* next */ }
  }
  return undefined;
}

async function probeVideo(file: string, context: ContentContext, runner: AcquisitionDeps["runTool"], command: string | undefined): Promise<MediaProbe | undefined> {
  if (!command) return undefined;
  const result = await (runner ?? localRunner)(command, ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", file], context).catch(() => undefined);
  if (!result || result.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { streams?: Array<{ codec_type?: string }>; format?: { duration?: string } };
    return { video: parsed.streams?.some((stream) => stream.codec_type === "video") ?? false, audio: parsed.streams?.some((stream) => stream.codec_type === "audio") ?? false, durationSeconds: Number(parsed.format?.duration) };
  } catch { return undefined; }
}

async function localRunner(command: string, args: string[], context: ContentContext): Promise<ToolRunResult> {
  return runContentTool({ command, args, cwd: context.directory, signal: context.signal, timeoutMs: 10 * 60_000, maxOutputBytes: 2 * 1024 * 1024 });
}

async function filesBelow(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
  const result: string[] = [];
  for (const entry of entries) { const target = path.join(root, entry.name); if (entry.isDirectory() && entry.name !== ".part") result.push(...await filesBelow(target)); else if (entry.isFile() && !entry.name.endsWith(".part") && !/^f\d+(?:\.|$)/i.test(entry.name)) result.push(target); }
  return result.sort((a, b) => a.localeCompare(b));
}

function roleFor(file: string): ContentAsset["role"] | undefined {
  const extension = path.extname(file).toLowerCase();
  if ([".mp4", ".webm", ".mkv", ".mov"].includes(extension)) return "video";
  if ([".m4a", ".mp3", ".opus", ".aac"].includes(extension)) return "audio";
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(extension)) return "cover";
  if ([".vtt", ".srt", ".ass", ".lrc"].includes(extension)) return "subtitle";
  if (file.toLowerCase().includes("comment")) return "comments";
  if (file.toLowerCase().includes("danmaku")) return "danmaku";
  if ([".json", ".description"].includes(extension)) return "source";
  return undefined;
}

function partIdForFile(file: string): string | undefined { return /\[([^\]]+)\](?:\.[^.]+)+$/u.exec(path.basename(file))?.[1]; }
export async function writeComments(directory: string, partId: string, comments: unknown[]): Promise<ContentAsset> {
  const safeId = createHash("sha256").update(partId).digest("hex").slice(0, 32);
  const relative = `comments/${safeId}.comments.json`;
  const root = await fs.realpath(directory); const target = path.resolve(root, relative);
  if (!isPathWithin(root, target)) throw new Error("评论路径超出资料目录");
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (!isPathWithin(root, await fs.realpath(path.dirname(target)))) throw new Error("评论目录包含符号链接");
  const temporary=await writableFile(root,`${relative}.part`);await writableFile(root,relative);
  await fs.writeFile(temporary, JSON.stringify(comments)); await atomicReplace(temporary, target);
  const stat = await fs.stat(target);
  return { id: relative, role: "comments", status: "saved", path: relative, bytes: stat.size, partId, provenance: "original" };
}
async function totalFileBytes(directory: string): Promise<number> {
  let total = 0; for (const file of await filesBelow(directory)) total += (await fs.stat(file)).size; return total;
}
async function readSmallText(file: string, maximum = 1024 * 1024): Promise<string> {
  const stat = await fs.stat(file); if (stat.size > maximum) throw new Error("文件超过可解析大小上限"); return fs.readFile(file, "utf8");
}

async function acquireBilibili(input: ContentInput, context: ContentContext, deps: AcquisitionDeps): Promise<CapturedContent> {
  const content = capturedBase(input, "video");
  const command = deps.ytDlpPath ?? await executable(context.runtimeRoot);
  if (!command) { content.assets.push({ id: "yt-dlp", role: "source", status: "missing_dependency", reason: "未找到 yt-dlp；请放入 runtimeRoot/tools 或 PATH" }); content.coverage!.media = "not_attempted: yt-dlp unavailable"; await checkpoint(context, content); return content; }
  const runner = deps.runTool ?? localRunner;
  const ffprobe = deps.probeMedia ? undefined : await executable(context.runtimeRoot, process.platform === "win32" ? ["ffprobe.exe", "ffprobe"] : ["ffprobe"]);
  const ffmpeg = await executable(context.runtimeRoot, process.platform === "win32" ? ["ffmpeg.exe", "ffmpeg"] : ["ffmpeg"]);
  const cookiePath = path.join(context.runtimeRoot, ".content-profile", "bilibili", "cookies.txt");
  const hasCookies = await fs.stat(cookiePath).then((stat) => stat.isFile() && stat.size > 0).catch(() => false);
  const hardened = ["--ignore-config", "--no-plugin-dirs", "--no-warnings", ...(hasCookies ? ["--cookies", cookiePath] : [])];
  const metadataResult = await runner(command, [...hardened, "--dump-single-json", "--yes-playlist", input.url], context).catch((error: unknown) => ({ code: -1, stdout: "", stderr: error instanceof Error ? error.message : "tool failed", timedOut: false, cancelled: false, outputTruncated: false }));
  let metadata: { title?: string; uploader?: string; description?: string; duration?: number; entries?: Array<{ id?: string; title?: string; duration?: number }> } = {};
  try {
    const parsed: unknown = JSON.parse(metadataResult.stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("metadata is not an object");
    metadata = parsed as typeof metadata;
  } catch { content.warnings.push("yt-dlp 未返回可解析的元数据"); }
  content.title = safeTitle(metadata.title);
  content.author = metadata.uploader;
  content.markdown = metadata.description?.trim() ?? "";
  content.parts = (metadata.entries?.length ? metadata.entries : [{ id: input.nativeId, title: metadata.title, duration: metadata.duration }]).map((part, offset): ContentPart => ({ id: part.id ?? String(offset + 1), title: safeTitle(part.title), status: "unavailable", durationSeconds: part.duration }));
  await checkpoint(context, content);
  if (metadataResult.code !== 0) { content.assets.push({ id: "metadata", role: "source", status: metadataResult.cancelled ? "unavailable" : "failed", reason: metadataResult.cancelled ? "下载已取消" : `yt-dlp 元数据读取失败（${metadataResult.code}）：${publicMessage(metadataResult.stderr||metadataResult.stdout||"没有诊断输出").slice(-600)}` }); content.coverage!.metadata = "failed"; await checkpoint(context, content); return content; }
  await fs.mkdir(path.join(context.directory, "media"), { recursive: true });
  const seen = new Set<string>(); let anyFailure = false; let cancelled = false; let outputTruncated = false;
  const parts = content.parts ?? [];
  for (const [offset, part] of parts.entries()) {
    if (offset >= BILIBILI_MAX_PARTS) { part.status = "unavailable"; part.reason = `超过 ${BILIBILI_MAX_PARTS} 个分P保存上限`; await checkpoint(context, content); continue; }
    const existingBytes = await totalFileBytes(context.directory);
    if (existingBytes > BILIBILI_MAX_TOTAL_BYTES - BILIBILI_MAX_FILE_BYTES) { part.status = "unavailable"; part.reason = `超过 ${BILIBILI_MAX_TOTAL_BYTES / 1024 / 1024 / 1024}GB 总量上限`; await checkpoint(context, content); continue; }
    const partFolder = createHash("sha256").update(part.id).digest("hex").slice(0, 24);
    const partDirectory = path.join(context.directory, "media", partFolder);
    await fs.mkdir(path.dirname(partDirectory), { recursive: true });
    try { if ((await fs.lstat(partDirectory)).isSymbolicLink()) throw new Error("分P输出目录不能是符号链接"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { part.status = "failed"; part.reason = error instanceof Error ? error.message : "分P输出目录不安全"; await checkpoint(context, content); continue; } }
    await fs.mkdir(partDirectory, { recursive: true });
    if (!isPathWithin(await fs.realpath(context.directory), await fs.realpath(partDirectory))) { part.status = "failed"; part.reason = "分P输出目录超出资料目录"; await checkpoint(context, content); continue; }
    const args = [...hardened, "--playlist-items", String(offset + 1), "--max-filesize", "2G", "--write-info-json", "--write-thumbnail", "--write-subs", "--write-auto-subs", "--sub-langs", "all", "--write-comments", "--write-description", "--format", "bestvideo*+bestaudio/best", "--merge-output-format", "mp4", ...(ffmpeg ? ["--ffmpeg-location", path.dirname(ffmpeg)] : []), "--paths", `home:${context.directory}`, "--paths", `temp:${path.join(context.directory, ".part")}`, "-o", `media/${partFolder}/%(title).80B [%(id)s].%(ext)s`, input.url];
    const result = await runner(command, args, context).catch((error: unknown) => ({ code: -1, stdout: "", stderr: publicMessage(error), timedOut: false, cancelled: false, outputTruncated: false }));
    anyFailure ||= result.code !== 0; cancelled ||= result.cancelled; outputTruncated ||= result.outputTruncated;
    if (result.code !== 0 && result.stderr.trim()) content.warnings.push(`yt-dlp（${part.title}）：${publicMessage(result.stderr).slice(0, 600)}`);
    const files = await filesBelow(partDirectory);
    for (const file of files) {
      if (seen.has(file) || !isPathWithin(context.directory, file)) continue;
      seen.add(file);
      if (file.endsWith(".info.json")) {
        try {
          const info = JSON.parse(await readSmallText(file)) as { id?: string; comments?: unknown[] };
          if (info.id !== part.id) { content.warnings.push(`忽略不属于当前分P的元数据文件：${part.title}`); continue; }
          if (Array.isArray(info.comments) && info.comments.length) { content.assets.push(await writeComments(context.directory, part.id, info.comments)); await checkpoint(context, content); }
        } catch { content.warnings.push("一份 B 站元数据无法解析，未导出其评论"); }
        continue; // yt-dlp metadata may contain signed URLs; never expose it as a reading asset.
      }
      const role = roleFor(file); if (!role) continue;
      const stat = await fs.stat(file); const relative = path.relative(context.directory, file).replaceAll("\\", "/"); const partId = part.id;
      let status: ContentAsset["status"] = "saved"; let reason: string | undefined;
      if (result.code !== 0) { status = "failed"; reason = "该分P下载进程未成功结束，文件可能不完整"; }
      else if (stat.size > BILIBILI_MAX_FILE_BYTES) { status = "failed"; reason = "文件超过 2GB 单项上限"; }
      if (role === "video" && status === "saved") {
        const probe = deps.probeMedia ? await deps.probeMedia(file, context) : await probeVideo(file, context, runner, ffprobe);
        if (!probe) { status = "unavailable"; reason = "未验证视频音轨（缺少 ffprobe）"; }
        else if (!probe.video || !probe.audio) { status = "failed"; reason = "视频文件缺少视频或音频流"; }
        else if (Number.isFinite(probe.durationSeconds) && part.durationSeconds !== undefined) {
          const delta = Math.abs(probe.durationSeconds! - part.durationSeconds); const tolerance = Math.max(2, part.durationSeconds * 0.03);
          content.coverage![`part:${partId}:duration`] = `metadata=${part.durationSeconds}s actual=${probe.durationSeconds}s delta=${delta.toFixed(2)}s ${delta <= tolerance ? "verified" : "mismatch"}`;
          if (delta > tolerance) { status = "failed"; reason = "媒体时长与元数据不符"; }
        } else content.coverage![`part:${partId}:duration`] = "unknown: missing metadata or ffprobe duration";
      }
      content.assets.push({ id: relative, role, status, path: relative, bytes: stat.size, partId, provenance: role === "subtitle" ? "platform_subtitle" : "original", ...(reason ? { reason } : {}) });
      await checkpoint(context, content);
    }
    const verified = content.assets.some((asset) => asset.role === "video" && asset.partId === part.id && asset.status === "saved");
    part.status = verified ? "saved" : result.code === 0 ? "partial" : "failed";
    await checkpoint(context, content);
    if (context.signal?.aborted) break;
  }
  const persistedBytes = await totalFileBytes(context.directory);
  if (persistedBytes > BILIBILI_MAX_TOTAL_BYTES) {
    for (const asset of content.assets.filter((asset) => asset.status === "saved" && asset.path?.startsWith("media/"))) { asset.status = "failed"; asset.reason = "下载后超过 10GB 总量上限，不能作为完整保存结果"; }
    content.warnings.push("下载后超过 10GB 总量上限，已保留文件但不标记为成功");
  }
  for (const part of parts) {
    const records = content.assets.filter((asset) => asset.role === "video" && asset.partId === part.id);
    if (records.some((asset) => asset.status === "saved")) part.status = "saved";
    else if (records.length) part.status = "partial";
    for(const role of ["subtitle","comments"] as const){const items=content.assets.filter(a=>a.partId===part.id&&a.role===role);const saved=items.filter(a=>a.status==="saved");content.coverage![`part:${part.id}:${role}`]=saved.length?`saved: ${saved.length} file(s); total coverage unknown`:items.length?"failed":"unavailable";}
  }
  const videos = content.assets.filter((asset) => asset.role === "video" && asset.status === "saved");
  content.coverage!.media = videos.length ? `saved: ${videos.length}/${parts.length} verified part(s); ${persistedBytes}/${BILIBILI_MAX_TOTAL_BYTES} bytes, per-file limit 2G` : cancelled ? "cancelled" : "failed: no verified media file";
  content.coverage!.subtitles = content.assets.some((asset) => asset.role === "subtitle"&&asset.status==="saved") ? `saved: ${content.assets.filter((asset) => asset.role === "subtitle"&&asset.status==="saved").length} file(s)` : "unavailable";
  content.coverage!.comments = content.assets.some((asset) => asset.role === "comments"&&asset.status==="saved") ? `saved: ${content.assets.filter((asset) => asset.role === "comments"&&asset.status==="saved").length} part file(s); total coverage unknown` : "unavailable";
  content.coverage!.danmaku = content.assets.some((asset) => asset.role === "danmaku" && asset.status === "saved") ? "saved" : "unknown: yt-dlp does not reliably export Bilibili danmaku";
  if (anyFailure) content.warnings.push(cancelled ? "下载已取消，已保留完成的部分文件" : "yt-dlp 下载未完整成功，已保留完成的部分文件");
  if (outputTruncated) content.warnings.push("yt-dlp 输出达到记录上限；请检查本地文件确认结果");
  await checkpoint(context, content);
  return content;
}

/** Captures webpage, Xiaohongshu or Bilibili content into the caller-controlled directory. */
export async function acquireContent(input: ContentInput, context: ContentContext, deps: AcquisitionDeps = {}): Promise<CapturedContent> {
  await fs.mkdir(context.directory, { recursive: true });
  if (context.signal?.aborted) throw new DOMException("已取消", "AbortError");
  if (input.platform === "xiaohongshu") return acquireXiaohongshu(input, context, deps);
  if (input.platform === "bilibili") return acquireBilibili(input, context, deps);
  if (input.platform === "wechat") return { ...capturedBase(input, "article"), warnings: ["微信采集由现有采集器适配层处理"], coverage: { body: "delegated: wechat adapter" } };
  return acquireWeb(input, context);
}

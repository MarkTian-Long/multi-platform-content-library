import fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { load } from "cheerio";
import TurndownService from "turndown";
import { containedFile, fileHash, publicUrl, writableFile } from "./content-library.js";
import { runContentTool } from "./content-tools.js";
import { isPathWithin } from "./url-policy.js";
import { DocumentImportError, extractDocumentText, inspectImportedImage, type DocumentImportLimits, type DocumentText, type ImportedImage } from "./content-document-import.js";
import type { CapturedContent, ContentContext, ContentKind } from "./content-types.js";

export interface LocalImportContext extends ContentContext {
  allowedRoot?: string;
  allowedRoots?: readonly string[];
  explicitPath?: string;
  maxTextBytes?: number;
  maxMediaBytes?: number;
  maxDocumentBytes?: number;
  maxImageBytes?: number;
  documentLimits?: DocumentImportLimits;
  textEncoding?: "utf-8" | "gb18030";
}
export type LocalImportFormat = "txt" | "markdown" | "html" | "pdf" | "docx" | "png" | "jpeg" | "webp" | "bmp" | "mp4" | "mov" | "m4a" | "webm" | "mkv" | "mp3" | "wav" | "aac" | "flac" | "ogg";
type MediaStream = { codec_type?: string; codec_name?: string; disposition?: { attached_pic?: number } };
export interface ImportedLocalContent extends CapturedContent {
  platform: "local";
  localSource: { fileName: string; format: LocalImportFormat; bytes: number; sha256: string; reusedSnapshot: boolean; textEncoding?: string; media?: { streams: MediaStream[]; durationSeconds: number }; document?: Omit<DocumentText, "markdown" | "warnings">; image?: ImportedImage };
}

export const LOCAL_IMPORT_EXTENSIONS = [".txt", ".md", ".markdown", ".html", ".htm", ".pdf", ".docx", ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".mp4", ".mov", ".m4a", ".webm", ".mkv", ".mp3", ".wav", ".aac", ".flac", ".ogg"] as const;
const TEXT_MAX = 8 * 1024 * 1024, INDEX_MAX = 4 * 1024 * 1024, MEDIA_MAX = 2 * 1024 * 1024 * 1024;
const formats: Record<string, LocalImportFormat> = { ".txt": "txt", ".md": "markdown", ".markdown": "markdown", ".html": "html", ".htm": "html", ".pdf": "pdf", ".docx": "docx", ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".webp": "webp", ".bmp": "bmp", ".mp4": "mp4", ".mov": "mov", ".m4a": "m4a", ".webm": "webm", ".mkv": "mkv", ".mp3": "mp3", ".wav": "wav", ".aac": "aac", ".flac": "flac", ".ogg": "ogg" };
const textFormats = new Set<LocalImportFormat>(["txt", "markdown", "html"]);
const imageFormats = new Set<LocalImportFormat>(["png", "jpeg", "webp", "bmp"]);
/** Shared with queue preflight; JPG/JPEG and MD/MARKDOWN share byte-based identities. */
export function localImportFormat(fileNameOrExtension: string): LocalImportFormat | undefined {
  return formats[(fileNameOrExtension.startsWith(".") && !/[\\/]/.test(fileNameOrExtension) ? fileNameOrExtension : path.extname(fileNameOrExtension)).toLowerCase()];
}
export function localImportByteLimit(fileNameOrExtension: string, limits: Pick<LocalImportContext, "maxTextBytes" | "maxMediaBytes" | "maxDocumentBytes" | "maxImageBytes"> = {}): number {
  const format = localImportFormat(fileNameOrExtension);
  if (!format) throw new LocalImportError("UNSUPPORTED_FORMAT", "不支持此本地导入格式");
  if (textFormats.has(format)) return boundedLimit(limits.maxTextBytes, TEXT_MAX);
  if (format === "pdf" || format === "docx") return boundedLimit(limits.maxDocumentBytes, 32 * 1024 * 1024);
  if (imageFormats.has(format)) return boundedLimit(limits.maxImageBytes, 32 * 1024 * 1024);
  return boundedLimit(limits.maxMediaBytes, MEDIA_MAX);
}
const samePath = (a: string, b: string) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const visibleTitle = (value: string) => Array.from(value.replace(/[\x00-\x1f\x7f]/g, " ").trim()).slice(0, 160).join("") || "本地文件";

export class LocalImportError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "LocalImportError"; }
}
function localAbsolute(value: string): string {
  if (typeof value !== "string" || !value || /[\x00-\x1f]/.test(value) || !path.isAbsolute(value) || /^[\\/]{2}/.test(value) || process.platform === "win32" && !/^[a-z]:[\\/]/i.test(value)) throw new LocalImportError("INVALID_PATH", "只接受本机绝对文件路径，不接受链接、网络/设备或相对路径");
  return path.resolve(value);
}
async function noLinks(absolute: string): Promise<void> {
  let current = path.parse(absolute).root;
  for (const part of path.relative(current, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new LocalImportError("SYMLINK", "源文件和路径祖先不能是符号链接或目录链接");
  }
}
function sameStat(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function authorize(source: string, context: LocalImportContext): Promise<{ source: string; stat: BigIntStats }> {
  const absolute = localAbsolute(source);
  const selected = context.explicitPath !== undefined ? localAbsolute(context.explicitPath) : undefined;
  const roots = [...(context.allowedRoots ?? []), ...(context.allowedRoot ? [context.allowedRoot] : [])].map(localAbsolute);
  if (!(selected && samePath(absolute, selected)) && !roots.some(root => isPathWithin(root, absolute))) throw new LocalImportError("NOT_AUTHORIZED", "文件不在授权目录白名单内，也不是用户明确选择的文件");
  await noLinks(absolute);
  const stat = await fs.lstat(absolute, { bigint: true });
  if (!stat.isFile()) throw new LocalImportError("NOT_FILE", "导入源必须是普通文件");
  const real = await fs.realpath(absolute);
  let allowed = false;
  if (selected !== undefined) {
    await noLinks(selected);
    allowed = samePath(absolute, selected) && samePath(real, await fs.realpath(selected));
  }
  for (const approved of roots) {
    await noLinks(approved);
    if (!(await fs.stat(approved)).isDirectory()) throw new LocalImportError("INVALID_GRANT", "目录白名单必须指向真实目录");
    if (isPathWithin(approved, absolute) && isPathWithin(await fs.realpath(approved), real)) allowed = true;
  }
  if (!allowed) throw new LocalImportError("NOT_AUTHORIZED", "文件不在授权目录白名单内，也不是用户明确选择的文件");
  return { source: absolute, stat };
}
function boundedLimit(value: number | undefined, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new LocalImportError("INVALID_LIMIT", "大小上限必须是正整数，且不能高于应用硬上限");
  return value;
}
function decodeText(bytes: Buffer, requested: LocalImportContext["textEncoding"]): { text: string; encoding: string } {
  let encoding: string = requested || "utf-8", start = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = "utf-16le"; start = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = "utf-16be"; start = 2; }
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { encoding = "utf-8"; start = 3; }
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(start)); }
  catch { throw new LocalImportError("TEXT_ENCODING", "文字编码无法读取；默认严格 UTF-8，旧中文编码请明确指定 gb18030"); }
  if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text)) throw new LocalImportError("BINARY_TEXT", "文本文件包含二进制控制字节");
  if (!text.trim()) throw new LocalImportError("EMPTY_TEXT", "文字文件没有可用正文");
  return { text, encoding };
}
function staticHtml(source: string): { markdown: string; title: string; warnings: string[] } {
  const $ = load(source);
  $("script,style,noscript,iframe,frame,frameset,object,embed,template,form,svg,canvas,base,meta,link,[hidden]").remove();
  $("*").each((_, element) => {
    const node = $(element);
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(node.attr("style") || "")) { node.remove(); return; }
    const attributes = (element as unknown as { attribs?: Record<string, string> }).attribs || {};
    for (const name of Object.keys(attributes)) if (/^on/i.test(name) || ["style", "src", "srcset", "action", "formaction", "poster", "background", "data"].includes(name.toLowerCase())) node.removeAttr(name);
  });
  const documentTitle = $("h1").first().text() || $("title").first().text();
  const images = $("img").length;
  $("img").each((_, element) => { const alt = $(element).attr("alt")?.trim(); $(element).replaceWith($("<span>").text(alt ? `（未导入图片：${alt}）` : "（图片未导入）")); });
  $("audio,video,source,track").remove();
  $("a").each((_, element) => {
    const node = $(element), href = node.attr("href") || "", label = node.text();
    let url = "";
    try { const parsed = new URL(href); if (/^https?:$/.test(parsed.protocol)) url = publicUrl(href); } catch { /* Relative references are not followed. */ }
    node.replaceWith($("<span>").text(url ? `${label}（${url}）` : label));
  });
  if (!$("body").text().trim()) throw new LocalImportError("EMPTY_HTML", "HTML 没有可用静态正文（脚本内容不算正文）");
  const markdown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" }).turndown($("body").html() || "").trim();
  if (!markdown) throw new LocalImportError("EMPTY_HTML", "HTML 静态正文转换结果为空");
  return { markdown, title: visibleTitle(documentTitle), warnings: images ? ["HTML 中的图片只保留文字提示，未自动导入引用资源"] : [] };
}
function mediaSignature(format: LocalImportFormat, bytes: Buffer): boolean {
  if (["mp4", "m4a", "mov"].includes(format)) return bytes.subarray(4, 8).toString("ascii") === "ftyp";
  if (["mkv", "webm"].includes(format)) return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (format === "wav") return bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WAVE";
  if (format === "flac") return bytes.subarray(0, 4).toString() === "fLaC";
  if (format === "ogg") return bytes.subarray(0, 4).toString() === "OggS";
  if (format === "mp3") return bytes.subarray(0, 3).toString() === "ID3" || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  if (format === "aac") return bytes.subarray(0, 4).toString() === "ADIF" || bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
  return false;
}
async function probeMedia(file: string, format: LocalImportFormat, header: Buffer, context: LocalImportContext): Promise<NonNullable<ImportedLocalContent["localSource"]["media"]>> {
  if (!mediaSignature(format, header)) throw new LocalImportError("MEDIA_SIGNATURE", "媒体文件头与扩展名不符，不接受播放列表或伪装媒体");
  const demuxer = ["mp4", "m4a", "mov"].includes(format) ? "mov" : ["mkv", "webm"].includes(format) ? "matroska" : format;
  const localProbe = path.join(context.runtimeRoot, "tools", "ffprobe.exe");
  const command = process.env.CONTENT_FFPROBE_PATH || (await fs.stat(localProbe).then(s => s.isFile()).catch(() => false) ? localProbe : "ffprobe");
  const args = ["-v", "error", "-protocol_whitelist", "file", "-f", demuxer];
  if (demuxer === "mov") args.push("-enable_drefs", "0", "-use_absolute_path", "0");
  args.push("-show_entries", "format=duration:stream=codec_type,codec_name:stream_disposition=attached_pic", "-of", "json", file);
  const run = await runContentTool({ command, args, signal: context.signal, timeoutMs: 15000, maxOutputBytes: 64000 });
  if (run.code !== 0 || run.outputTruncated) throw new LocalImportError("MEDIA_PROBE", "媒体解析未通过：文件损坏、格式不支持或缺少本地 ffprobe");
  try {
    const data = JSON.parse(run.stdout), durationSeconds = Number(data.format?.duration);
    if (!Array.isArray(data.streams) || !data.streams.some((s: MediaStream) => ["audio", "video"].includes(s.codec_type || "")) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error();
    return { streams: data.streams, durationSeconds };
  } catch { throw new LocalImportError("MEDIA_PROBE", "媒体流或时长无有效本地核验结果"); }
}

/** User-selected local files only. Never moves/modifies inputs, executes HTML, fetches resources or writes a library. */
export async function importLocalFile(sourcePath: string, context: LocalImportContext): Promise<ImportedLocalContent> {
  context.signal?.throwIfAborted();
  const { source, stat } = await authorize(sourcePath, context);
  const format = localImportFormat(source);
  if (!format) throw new LocalImportError("UNSUPPORTED_FORMAT", "不支持此文件格式；本轮支持文字、PDF/DOCX、原图与既有音视频格式");
  const isText = textFormats.has(format), isDocument = format === "pdf" || format === "docx", isImage = imageFormats.has(format), maximum = localImportByteLimit(source, context);
  if (stat.size === 0n) throw new LocalImportError("EMPTY_FILE", "原文件为空");
  if (stat.size > BigInt(maximum)) throw new LocalImportError("TOO_LARGE", "文件超过本地导入大小上限");
  const input = await fs.open(source, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  let pending: string | undefined;
  try {
    if (!sameStat(stat, await input.stat({ bigint: true }))) throw new LocalImportError("SOURCE_CHANGED", "打开时原文件已变化");
    const buffer = Buffer.alloc(256 * 1024), hash = createHash("sha256"); let position = 0, header = Buffer.alloc(0);
    for (;;) {
      context.signal?.throwIfAborted();
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position); if (!bytesRead) break;
      if (!position) header = Buffer.from(buffer.subarray(0, Math.min(32, bytesRead)));
      position += bytesRead; if (position > maximum) throw new LocalImportError("SOURCE_CHANGED", "读取期间文件大小变化或超过上限");
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (!sameStat(stat, await input.stat({ bigint: true }))) throw new LocalImportError("SOURCE_CHANGED", "读取期间原文件已变化");
    const sha256 = hash.digest("hex"), nativeId = `${format}:${sha256}`, id = createHash("sha256").update(`local:${nativeId}`).digest("hex").slice(0, 24);
    const extension = format === "markdown" ? "md" : format === "html" ? "html.txt" : format;
    const relative = `local-imports/${id}/original.${extension}`, destination = await writableFile(context.directory, relative);
    let snapshot = destination, reusedSnapshot = false;
    if (await fs.lstat(destination).then(() => true).catch(error => { if (error.code === "ENOENT") return false; throw error; })) {
      const existing = await containedFile(context.directory, relative);
      if ((await fs.stat(existing)).size !== position || await fileHash(existing) !== sha256) throw new LocalImportError("SNAPSHOT_INTEGRITY", "已存本地副本完整性/哈希校验失败，未覆盖原记录");
      reusedSnapshot = true;
    } else {
      pending = await writableFile(context.directory, `local-imports/${randomUUID()}.pending`);
      const output = await fs.open(pending, "wx");
      try {
        context.onProgress?.("正在复制原文件到本地暂存");
        const copyHash = createHash("sha256"); let offset = 0;
        for (;;) {
          context.signal?.throwIfAborted();
          const { bytesRead } = await input.read(buffer, 0, buffer.length, offset); if (!bytesRead) break;
          offset += bytesRead; if (offset > maximum) throw new LocalImportError("SOURCE_CHANGED", "复制期间原文件大小变化");
          copyHash.update(buffer.subarray(0, bytesRead));
          let written = 0;
          while (written < bytesRead) { const value = await output.write(buffer, written, bytesRead - written); if (!value.bytesWritten) throw new Error("文件写入未完成"); written += value.bytesWritten; }
        }
        await output.sync();
        if (copyHash.digest("hex") !== sha256 || !sameStat(stat, await input.stat({ bigint: true }))) throw new LocalImportError("SOURCE_CHANGED", "复制期间原文件已变化，未登记为已保存");
      } finally { await output.close(); }
      snapshot = pending;
    }
    const fileName = path.basename(source), stem = visibleTitle(path.parse(fileName).name);
    let markdown = "", title = stem, kind: ContentKind = "article", encoding: string | undefined, media: ImportedLocalContent["localSource"]["media"], warnings: string[] = [], document: DocumentText | undefined, image: ImportedImage | undefined;
    if (isText) {
      const decoded = decodeText(await fs.readFile(snapshot), context.textEncoding); encoding = decoded.encoding;
      if (format === "html") { const parsed = staticHtml(decoded.text); markdown = parsed.markdown; title = parsed.title === "本地文件" ? stem : parsed.title; warnings = parsed.warnings; }
      else { markdown = decoded.text; if (format === "markdown") title = visibleTitle(/^#\s+(.+)$/m.exec(markdown)?.[1] || stem); }
      if (Buffer.byteLength(markdown, "utf8") > INDEX_MAX) throw new LocalImportError("INDEX_TOO_LARGE", "解码后正文超过 4 MiB 索引上限，原文件未改动");
    } else if (isDocument) {
      context.onProgress?.(format === "pdf" ? "正在读取 PDF 文字层" : "正在读取 DOCX 主文档文字");
      try { document = await extractDocumentText(snapshot, format as "pdf" | "docx", context.documentLimits, context.signal); }
      catch (error) { if (error instanceof DocumentImportError) throw new LocalImportError(error.code, error.message); throw error; }
      markdown = document.markdown || `# ${title}\n\n${document.warnings[0] || "原件没有可提取文字，未登记正文成功。"}\n\n文件：${fileName}\n\n以下仅为导入状态说明，不是文档原文或 OCR 文字稿。\n`; warnings = document.warnings;
    } else if (isImage) {
      try { image = await inspectImportedImage(snapshot, format as ImportedImage["format"], context.signal); }
      catch (error) { if (error instanceof DocumentImportError) throw new LocalImportError(error.code, error.message); throw error; }
      kind = "gallery"; markdown = `# ${title}\n\n本地原图来源信息（不是 OCR 文字稿）。\n\n文件：${fileName}\n\n格式：${format}；尺寸：${image.width} × ${image.height}。\n`;
    } else {
      media = await probeMedia(snapshot, format, header, context);
      kind = media.streams.some(s => s.codec_type === "video" && !s.disposition?.attached_pic) ? "video" : "audio";
      markdown = `# ${title}\n\n本地${kind === "audio" ? "音频" : "视频"}的来源信息（不是语音文字稿）。\n\n文件：${fileName}\n\n格式：${format}；时长：${media.durationSeconds.toFixed(3)} 秒。\n`;
    }
    context.signal?.throwIfAborted();
    if ((isDocument || isImage) && ((await fs.stat(snapshot)).size !== position || await fileHash(snapshot) !== sha256)) throw new LocalImportError("SNAPSHOT_INTEGRITY", "解析期间本地快照字节或哈希已变化，未登记保存");
    await noLinks(source);
    if (!sameStat(stat, await fs.lstat(source, { bigint: true })) || !samePath(await fs.realpath(source), source)) throw new LocalImportError("SOURCE_CHANGED", "登记前原文件路径或内容已变化");
    if (pending) {
      // Link the NEW copied bytes, never the input inode. This publishes atomically
      // without overwriting another import's successful snapshot.
      try { await fs.link(pending, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await containedFile(context.directory, relative);
        if ((await fs.stat(existing)).size !== position || await fileHash(existing) !== sha256) throw new LocalImportError("SNAPSHOT_INTEGRITY", "并发副本哈希不一致，未登记保存");
        reusedSnapshot = true;
      }
    }
    const canonicalUrl = `local://sha256/${format}/${sha256}`, sourceId = `local-original-${id}`;
    const mediaMime = ["mp4", "m4a"].includes(format) ? `${kind}/mp4` : format === "mov" ? "video/quicktime" : format === "mkv" ? `${kind}/x-matroska` : format === "mp3" ? "audio/mpeg" : `${kind}/${format}`;
    const result: ImportedLocalContent = { platform: "local", nativeId, sourceUrl: canonicalUrl, canonicalUrl, title, capturedAt: new Date().toISOString(), kind, markdown, warnings, coverage: { body: isText ? format === "html" ? "已保存 HTML 静态文字；未执行脚本或加载外部资源" : "已保存原文件的可用完整文字" : "仅保存素材来源信息，语音全文由后续本地 ASR 生成", media: isText ? "原始文件已复制并核验哈希" : "原始音视频已复制，文件头、媒体流及时长已本地核验" }, assets: [{ id: sourceId, role: isText ? "source" : kind === "audio" ? "audio" : "video", status: "saved", path: relative, provenance: "original", bytes: position, sha256, mime: isText ? format === "markdown" ? "text/markdown" : "text/plain" : mediaMime, label: fileName, ...(media ? { partId: "local-file", startMs: 0, endMs: Math.floor(media.durationSeconds * 1000) } : {}) }], ...(media ? { parts: [{ id: "local-file", title, status: "saved" as const, durationSeconds: media.durationSeconds }] } : {}), localSource: { fileName, format, bytes: position, sha256, reusedSnapshot, textEncoding: encoding, media } };
    if (document) {
      const { markdown: extracted, warnings: extractionWarnings, ...metadata } = document;
      result.localSource.document = metadata;
      result.assets[0].role = "source"; result.assets[0].mime = format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      result.coverage!.body = document.searchable ? document.complete ? format === "pdf" ? `saved: PDF text layer, ${document.textPages}/${document.pages} pages` : "saved: DOCX main document text; layout and other story parts kept in original" : `partial: PDF text layer, ${document.textPages}/${document.pages} pages; missing pages not OCRed` : "unavailable: original document has no extractable text layer";
      result.coverage!.media = "原始文档已独立复制并核验哈希；未展开嵌入资源或访问外部关系";
    }
    if (image) {
      result.localSource.image = image; result.assets[0].role = "image"; result.assets[0].mime = image.mime;
      result.coverage!.body = "仅保存原图来源信息，图中文字由后续本地 OCR 生成";
      result.coverage!.media = "原图已独立复制并核验哈希、字节签名与尺寸；未上传";
    }
    await context.onCheckpoint?.(result);
    return result;
  } finally {
    await input.close();
    if (pending) await fs.unlink(pending).catch(() => {});
  }
}

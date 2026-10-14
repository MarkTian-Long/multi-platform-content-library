import fs from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { imageSize } from "image-size";

export interface DocumentImportLimits {
  maxPages?: number;
  maxTextBytes?: number;
  maxExpandedBytes?: number;
  maxZipEntries?: number;
  maxCompressionRatio?: number;
  timeoutMs?: number;
}
export interface DocumentText {
  markdown: string;
  searchable: boolean;
  complete: boolean;
  pages?: number;
  textPages?: number;
  expandedBytes?: number;
  entries?: number;
  warnings: string[];
}
export interface ImportedImage { width: number; height: number; format: "png" | "jpeg" | "webp" | "bmp"; mime: string; }
export class DocumentImportError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "DocumentImportError"; }
}
const defaults = { maxPages: 200, maxTextBytes: 4 * 1024 * 1024, maxExpandedBytes: 64 * 1024 * 1024, maxZipEntries: 2048, maxCompressionRatio: 100, timeoutMs: 30000 };
function bounded(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new DocumentImportError("INVALID_LIMIT", "文档解析上限必须为正整数且不能高于应用硬上限");
  return value;
}
// Plain JavaScript: works unchanged in compiled Node and tsx development runs.
// No document path, URL, executable or script is supplied to the parser worker.
const parserWorker = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs/promises"), path = require("node:path"), { fileURLToPath } = require("node:url");
const bytes = Buffer.from(workerData.bytes), limits = workerData.limits;
globalThis.fetch = async () => { throw new Error("Document network access disabled"); };
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const checkMemory = () => { if (process.memoryUsage().arrayBuffers > 128 * 1024 * 1024) fail("DOCUMENT_RESOURCE_LIMIT", "文档解析缓冲区超过128MiB上限"); };
const checkText = value => { if (Buffer.byteLength(value, "utf8") > limits.maxTextBytes) fail("INDEX_TOO_LARGE", "文档提取文字超过索引上限，未截断冒充全文"); };
async function pdfText() {
  const lib = await import(workerData.pdfModule);
  const root = fileURLToPath(new URL("../../", workerData.pdfModule));
  class LocalDataFactory {
    async fetch({ kind, filename }) {
      const directory = kind === "cMapUrl" ? "cmaps" : kind === "standardFontDataUrl" ? "standard_fonts" : undefined;
      if (!directory || !/^[A-Za-z0-9_.-]{1,96}$/.test(filename) || filename.includes("..")) throw new Error("Unsupported document resource");
      const base = await fs.realpath(path.join(root, directory)), target = await fs.realpath(path.join(base, filename));
      if (path.dirname(target) !== base || (await fs.stat(target)).size > 8 * 1024 * 1024) throw new Error("Unsupported document resource");
      return new Uint8Array(await fs.readFile(target));
    }
  }
  const loading = lib.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false, enableXfa: false, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, useWasm: false, BinaryDataFactory: LocalDataFactory, disableRange: true, disableStream: true, disableAutoFetch: true, stopAtErrors: true, maxImageSize: 40000000 });
  let pdf;
  try {
    pdf = await loading.promise;
    if (await pdf.getPermissions() !== null) fail("DOCUMENT_ENCRYPTED", "PDF 已加密；请先自行解密后重新导入");
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > limits.maxPages) fail("DOCUMENT_PAGE_LIMIT", "PDF 页数超过导入上限");
    const pages = []; let textPages = 0, total = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number), reader = page.streamTextContent({ disableNormalization: true }).getReader();
      const fragments = []; let size = 0;
      try {
        for (;;) {
          const item = await reader.read(); if (item.done) break;
          for (const text of item.value.items) if (typeof text.str === "string") {
            const value = text.str + (text.hasEOL ? "\n" : " "); size += Buffer.byteLength(value, "utf8");
            if (size + total > limits.maxTextBytes) fail("INDEX_TOO_LARGE", "PDF 文字超过索引上限，未截断冒充全文");
            fragments.push(value);
          }
          checkMemory();
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); page.cleanup(); }
      const text = fragments.join("").replace(/[ \t]+\n/g, "\n").trim();
      if (text) { textPages++; const value = "## 第 " + number + " 页\n\n" + text; total += Buffer.byteLength(value, "utf8") + 2; if (total > limits.maxTextBytes) fail("INDEX_TOO_LARGE", "PDF 文字超过索引上限"); pages.push(value); }
      checkMemory();
    }
    const warnings = [];
    if (!textPages) warnings.push("PDF 没有可提取的文字层，可能是扫描或空白文档；原件已保留，未伪造 OCR/全文");
    else if (textPages < pdf.numPages) warnings.push("PDF 有 " + (pdf.numPages - textPages) + " 页没有可提取文字；只索引已取得文字层，不标为全部页面全文");
    return { markdown: pages.join("\n\n"), searchable: textPages > 0, complete: textPages === pdf.numPages, pages: pdf.numPages, textPages, warnings };
  } catch (error) {
    if (error.name === "PasswordException") fail("DOCUMENT_ENCRYPTED", "PDF 已加密；请先自行解密后重新导入");
    throw error;
  } finally { await loading.destroy().catch(() => {}); }
}
async function docxText() {
  const { default: zipLib } = await import(workerData.zipModule), { SaxesParser } = await import(workerData.xmlModule);
  const zip = await zipLib.fromBufferPromise(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
  const files = new Map(), names = new Set(), table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let value = n; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; table[n] = value >>> 0; }
  let expanded = 0, entries = 0, external = false, extraStories = false, ignoredContent = false;
  function xml(text, onOpen, onText, onClose) {
    const parser = new SaxesParser({ xmlns: true }); let depth = 0;
    parser.on("doctype", () => fail("DOCUMENT_XML_UNSAFE", "DOCX 不接受 DTD 或外部实体"));
    parser.on("opentag", tag => { if (++depth > 128) fail("DOCUMENT_XML_LIMIT", "DOCX XML 嵌套超过上限"); onOpen?.(tag); });
    parser.on("text", value => onText?.(value)); parser.on("cdata", value => onText?.(value));
    parser.on("closetag", tag => { onClose?.(tag); depth--; }); parser.on("error", () => fail("DOCUMENT_XML_INVALID", "DOCX XML 损坏或结构不合法"));
    parser.write(text).close();
  }
  try {
    if (zip.entryCount > limits.maxZipEntries) fail("DOCUMENT_ZIP_LIMIT", "DOCX 压缩条目数超过上限");
    for await (const entry of zip.eachEntry()) {
      if (++entries > limits.maxZipEntries) fail("DOCUMENT_ZIP_LIMIT", "DOCX 压缩条目数超过上限");
      const name = entry.fileName, folded = name.toLowerCase();
      if (name.length > 512 || /[\x00-\x1f:\\]/.test(name) || name.startsWith("/") || name.split("/").includes("..") || names.has(folded) || (entry.externalFileAttributes >>> 16 & 0xf000) === 0xa000) fail("DOCUMENT_ZIP_PATH", "DOCX 含越界、重复或链接条目");
      names.add(folded);
      if (entry.isEncrypted()) fail("DOCUMENT_ENCRYPTED", "DOCX 压缩内容已加密，请先自行解密");
      if (![0, 8].includes(entry.compressionMethod)) fail("DOCUMENT_ZIP_METHOD", "DOCX 压缩方法不支持");
      if (/\/(?:embeddings|activex)\/|(?:vbaproject|vba)data|vbaproject\.bin/i.test(name)) fail("DOCUMENT_EMBEDDED_ACTIVE", "DOCX 含活动嵌入或宏，本轮不导入");
      if (entry.uncompressedSize > Math.min(limits.maxExpandedBytes, /\.(?:xml|rels)$/i.test(name) ? 8 * 1024 * 1024 : 16 * 1024 * 1024) || entry.uncompressedSize > Math.max(1024, entry.compressedSize * limits.maxCompressionRatio) || expanded + entry.uncompressedSize > limits.maxExpandedBytes) fail("DOCUMENT_EXPANSION_LIMIT", "DOCX 单条、总展开字节或压缩膨胀比超过上限");
      if (name.endsWith("/")) { if (entry.uncompressedSize) fail("DOCUMENT_ZIP_INVALID", "DOCX 目录条目含数据"); continue; }
      const stream = await zip.openReadStreamPromise(entry), collect = name === "word/document.xml" || name === "[Content_Types].xml" || name.endsWith(".rels"), chunks = []; let count = 0, crc = 0xffffffff;
      for await (const chunk of stream) {
        count += chunk.length; expanded += chunk.length;
        if (count > entry.uncompressedSize || expanded > limits.maxExpandedBytes) { stream.destroy(); fail("DOCUMENT_EXPANSION_LIMIT", "DOCX 实际展开大小与声明不符或超过上限"); }
        for (const byte of chunk) crc = table[(crc ^ byte) & 255] ^ crc >>> 8;
        if (collect) chunks.push(chunk); checkMemory();
      }
      if (count !== entry.uncompressedSize || (crc ^ 0xffffffff) >>> 0 !== entry.crc32) fail("DOCUMENT_ZIP_INTEGRITY", "DOCX 条目长度或 CRC 校验失败");
      if (collect) {
        let text; try { const source = Buffer.concat(chunks), encoding = source[0] === 255 && source[1] === 254 ? "utf-16le" : source[0] === 254 && source[1] === 255 ? "utf-16be" : "utf-8"; text = new TextDecoder(encoding, { fatal: true }).decode(source); } catch { fail("DOCUMENT_XML_INVALID", "DOCX XML 编码不合法"); }
        if (name.endsWith(".rels")) { xml(text, tag => { if (Object.values(tag.attributes).some(attr => attr.local === "TargetMode" && attr.value === "External")) external = true; }); if (name === "_rels/.rels") files.set(name, text); }
        else files.set(name, text);
      }
      if (/word\/(?:header|footer|footnotes|endnotes|comments)/i.test(name)) extraStories = true;
    }
    if (!files.has("word/document.xml") || !files.has("[Content_Types].xml") || !files.has("_rels/.rels")) fail("DOCUMENT_ZIP_INVALID", "文件不是含正文与包关系的 DOCX 包");
    const targets = [];
    xml(files.get("_rels/.rels"), tag => {
      const attrs = Object.values(tag.attributes);
      if (attrs.some(a => a.local === "Type" && ["http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument", "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument"].includes(a.value))) targets.push({ target: attrs.find(a => a.local === "Target")?.value, external: attrs.some(a => a.local === "TargetMode" && a.value === "External") });
    });
    if (targets.length !== 1 || !["word/document.xml", "/word/document.xml"].includes(targets[0].target) || targets[0].external) fail("DOCUMENT_ZIP_INVALID", "DOCX 包没有唯一、本地的标准正文关系");
    let type = false;
    xml(files.get("[Content_Types].xml"), tag => { const attrs = Object.values(tag.attributes); if (attrs.some(a => a.local === "PartName" && a.value === "/word/document.xml") && attrs.some(a => a.local === "ContentType" && a.value === "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml")) type = true; });
    if (!type) fail("DOCUMENT_ZIP_INVALID", "DOCX 主文档内容类型不符，不接受伪装或宏文档");
    const namespaces = new Set(["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"]);
    const stack = [], output = []; let body = false, document = false, hasBody = false, skipped = 0, text = false, size = 0;
    const add = value => { size += Buffer.byteLength(value, "utf8"); if (size > limits.maxTextBytes) fail("INDEX_TOO_LARGE", "DOCX 文字超过索引上限，未截断冒充全文"); output.push(value); };
    xml(files.get("word/document.xml"), tag => {
      const word = namespaces.has(tag.uri), local = word ? tag.local : ""; stack.push(local);
      if (stack.length === 1 && local !== "document") fail("DOCUMENT_XML_INVALID", "DOCX 主文档根节点不合法");
      if (local === "document") document = true;
      if (local === "body") { if (stack.length !== 2 || stack[0] !== "document" || hasBody) fail("DOCUMENT_XML_INVALID", "DOCX 正文节点结构不合法"); body = true; hasBody = true; }
      if (local === "del" || local === "moveFrom") skipped++;
      if (local === "altChunk" || local === "drawing" || local === "object") ignoredContent = true;
      text = body && !skipped && local === "t";
      if (body && !skipped && ["tab", "br", "cr"].includes(local)) add(local === "tab" ? "\t" : "\n");
    }, value => { if (text) add(value); }, tag => {
      const local = stack.pop(); if (body && !skipped && local === "p") add("\n\n"); if (body && !skipped && local === "tc") add("\t");
      if (local === "del" || local === "moveFrom") skipped--;
      if (local === "body") body = false;
      text = body && !skipped && stack.at(-1) === "t";
    });
    if (!document || !hasBody) fail("DOCUMENT_XML_INVALID", "DOCX 正文根节点不合法");
    const markdown = output.join("").trim(), warnings = [];
    if (!markdown) warnings.push("DOCX 主文档没有可检索文字；原件已保留，未登记文字提取成功");
    if (external) warnings.push("DOCX 外部关系未访问；仅保留主文档文字和原件");
    if (extraStories || ignoredContent) warnings.push("DOCX 索引范围为主文档文字；页眉页脚、脚注、图形/替代嵌入未展开，完整内容仍在原件中");
    checkText(markdown); return { markdown, searchable: !!markdown, complete: !!markdown, expandedBytes: expanded, entries, warnings };
  } finally { zip.close(); }
}
(workerData.format === "pdf" ? pdfText() : docxText()).then(value => parentPort.postMessage({ ok: true, value }), error => parentPort.postMessage({ ok: false, code: error.code || "DOCUMENT_INVALID", message: error.code ? error.message : "文档损坏或结构不支持，未登记可检索正文" }));
`;

/** Bounded, offline text extraction. Workers can be terminated independently of the queue. */
export async function extractDocumentText(file: string, format: "pdf" | "docx", options: DocumentImportLimits = {}, signal?: AbortSignal): Promise<DocumentText> {
  signal?.throwIfAborted();
  const limits = Object.fromEntries(Object.entries(defaults).map(([key, maximum]) => [key, bounded(options[key as keyof DocumentImportLimits], maximum)]));
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > 32 * 1024 * 1024) throw new DocumentImportError("TOO_LARGE", "解析输入必须是非空普通文档且不超过32MiB");
  const bytes = await fs.readFile(file);
  if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new DocumentImportError("TOO_LARGE", "文档字节为空或超过32MiB上限");
  if (format === "pdf" && !bytes.subarray(0, 8).toString("ascii").match(/^%PDF-[12]\.[0-9]/)) throw new DocumentImportError("DOCUMENT_SIGNATURE", "PDF 文件头与扩展名不符");
  if (format === "docx" && !bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) {
    if (bytes.subarray(0, 8).equals(Buffer.from([208,207,17,224,161,177,26,225])) && bytes.includes(Buffer.from("EncryptedPackage", "utf16le"))) throw new DocumentImportError("DOCUMENT_ENCRYPTED", "DOCX 已加密，请先自行解密");
    throw new DocumentImportError("DOCUMENT_SIGNATURE", "DOCX 文件头不是 OOXML ZIP；不支持旧版 DOC 或伪装文件");
  }
  const input = new Uint8Array(bytes);
  const worker = new Worker(parserWorker, { eval: true, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 }, transferList: [input.buffer], workerData: { bytes: input, format, limits, pdfModule: import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs"), zipModule: import.meta.resolve("yauzl"), xmlModule: import.meta.resolve("saxes") } });
  try {
    return await new Promise<DocumentText>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: DocumentText) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(value!); };
      const abort = () => finish(signal?.reason || new DocumentImportError("CANCELLED", "文档导入已取消"));
      const timer = setTimeout(() => finish(new DocumentImportError("DOCUMENT_TIMEOUT", "文档解析超过时间上限，原件未改动")), limits.timeoutMs);
      worker.once("message", message => message.ok ? finish(undefined, message.value) : finish(new DocumentImportError(message.code, message.message)));
      worker.once("error", () => finish(new DocumentImportError("DOCUMENT_RESOURCE_LIMIT", "文档解析线程失败或超过内存上限")));
      worker.once("exit", () => finish(new DocumentImportError("DOCUMENT_INVALID", "文档解析线程未返回有效结果")));
      signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    });
  } finally { await worker.terminate(); }
}

/** Raster metadata only; SVG and other executable/reference-bearing formats are not supported. */
export async function inspectImportedImage(file: string, expected: ImportedImage["format"], signal?: AbortSignal): Promise<ImportedImage> {
  signal?.throwIfAborted(); const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > 32 * 1024 * 1024) throw new DocumentImportError("TOO_LARGE", "解析输入必须是非空普通原图且不超过32MiB");
  const bytes = await fs.readFile(file);
  if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new DocumentImportError("TOO_LARGE", "原图字节为空或超过32MiB上限");
  const signature = expected === "png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : expected === "jpeg" ? bytes.subarray(0, 3).equals(Buffer.from([255,216,255])) : expected === "bmp" ? bytes.subarray(0, 2).toString() === "BM" : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  if (!signature) throw new DocumentImportError("IMAGE_SIGNATURE", "原图字节签名与扩展名不符");
  let dimensions; try { dimensions = imageSize(bytes); } catch { throw new DocumentImportError("IMAGE_INVALID", "原图文件损坏或没有可核验尺寸"); }
  const actual = dimensions.type === "jpg" ? "jpeg" : dimensions.type;
  if (actual !== expected || !Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height) || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 32768 || dimensions.height > 32768 || dimensions.width * dimensions.height > 40000000) throw new DocumentImportError("IMAGE_DIMENSIONS", "原图尺寸无效或超过32768边长/4000万像素上限");
  if (expected === "png" && (bytes.length < 33 || !bytes.subarray(-12, -8).equals(Buffer.alloc(4)) || bytes.subarray(-8, -4).toString() !== "IEND") || expected === "jpeg" && !bytes.subarray(-2).equals(Buffer.from([255,217])) || expected === "webp" && (bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length) || expected === "bmp" && (bytes.length < 54 || bytes.readUInt32LE(2) !== bytes.length || bytes.readUInt32LE(10) >= bytes.length)) throw new DocumentImportError("IMAGE_INVALID", "原图结构长度或结束标记损坏");
  signal?.throwIfAborted(); return { width: dimensions.width, height: dimensions.height, format: expected, mime: `image/${expected}` };
}

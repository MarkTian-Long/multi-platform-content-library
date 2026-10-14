import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { crc32, deflateRawSync, deflateSync } from "node:zlib";
import { importLocalFile, localImportByteLimit, localImportFormat, LOCAL_IMPORT_EXTENSIONS } from "../src/content-local-import.js";
import { extractDocumentText } from "../src/content-document-import.js";
import { contentStatus } from "../src/content-library.js";

const base = path.join(process.cwd(), "logs/usability-20261014/document-import-unit"), sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t: TestContext) {
  await fs.mkdir(base, { recursive: true }); const directory = await fs.mkdtemp(path.join(base, "case-"));
  const source = path.join(directory, "source"), stage = path.join(directory, "stage"); await fs.mkdir(source); await fs.mkdir(stage);
  t.after(async () => { const resolved = await fs.realpath(directory), parent = await fs.realpath(base); assert.equal(path.dirname(resolved), parent); await fs.rm(resolved, { recursive: true, force: true }); });
  return { source, stage, context: { runtimeRoot: process.cwd(), directory: stage, allowedRoot: source }, async write(name: string, bytes: Buffer | string) { const file = path.join(source, name); await fs.writeFile(file, bytes); return file; } };
}
function pdf(contents: Buffer[], options: { compressed?: boolean; encrypted?: boolean; chinese?: boolean } = {}): Buffer {
  const objects: Buffer[] = [Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"), Buffer.from(`<< /Type /Pages /Count ${contents.length} /Kids [${contents.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] >>`), Buffer.from(options.chinese ? "<< /Type /Font /Subtype /Type0 /BaseFont /TestCJK /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>" : "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")];
  for (const content of contents) {
    const stream = options.compressed ? deflateSync(content) : content;
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`));
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${stream.length}${options.compressed ? " /Filter /FlateDecode" : ""} >>\nstream\n`), stream, Buffer.from("\nendstream")]));
  }
  if (options.chinese) {
    objects.push(Buffer.from("<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TestCJK /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>"));
    const cmap = Buffer.from("/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Test def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0001> <4E2D> <0002> <6587> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end");
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${cmap.length} >>\nstream\n`), cmap, Buffer.from("\nendstream")]));
  }
  let encryption = "";
  if (options.encrypted) { objects.push(Buffer.from(`<< /Filter /Standard /V 1 /R 2 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4 >>`)); encryption = ` /Encrypt ${objects.length} 0 R /ID [<${"00".repeat(16)}> <${"00".repeat(16)}>]`; }
  const chunks = [Buffer.from("%PDF-1.7\n%\x80\x81\x82\x83\n", "latin1")], offsets = [0]; let position = chunks[0].length;
  for (const [index, object] of objects.entries()) { offsets.push(position); const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]); chunks.push(chunk); position += chunk.length; }
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryption} >>\nstartxref\n${position}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
const textPdf = () => pdf([Buffer.from("BT /F1 12 Tf 10 100 Td (Original searchable PDF.) Tj 0 -20 Td (Qualifier retained.) Tj ET")], { compressed: true });
type ZipEntry = { name: string; data: string | Buffer; deflate?: boolean; encrypted?: boolean; declaredSize?: number; symlink?: boolean };
function zip(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.from(entry.data), compressed = entry.deflate ? deflateRawSync(raw) : raw, data = entry.encrypted ? Buffer.concat([Buffer.alloc(12), compressed]) : compressed, name = Buffer.from(entry.name), flag = 0x800 | (entry.encrypted ? 1 : 0), size = entry.declaredSize ?? raw.length;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(flag, 6); header.writeUInt16LE(entry.deflate ? 8 : 0, 8); header.writeUInt32LE(crc32(raw), 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(size, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(0x314, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(flag, 8); dir.writeUInt16LE(entry.deflate ? 8 : 0, 10); dir.writeUInt32LE(crc32(raw), 16); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(size, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(entry.symlink ? 0xa000 << 16 >>> 0 : 0, 38); dir.writeUInt32LE(offset, 42); central.push(dir, name); offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), tail = Buffer.alloc(22); tail.writeUInt32LE(0x06054b50); tail.writeUInt16LE(entries.length, 8); tail.writeUInt16LE(entries.length, 10); tail.writeUInt32LE(directory.length, 12); tail.writeUInt32LE(offset, 16); return Buffer.concat([...local, directory, tail]);
}
const contentTypes = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const rootRelationships = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const body = (content: string) => `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${content}</w:body></w:document>`;
const docx = (xml: string, extra: ZipEntry[] = []) => zip([{ name: "[Content_Types].xml", data: contentTypes }, { name: "_rels/.rels", data: rootRelationships }, { name: "word/document.xml", data: xml }, ...extra]);
function png(width = 2, height = 2): Buffer {
  const chunk = (type: string, data: Buffer) => { const size = Buffer.alloc(4), crc = Buffer.alloc(4), value = Buffer.concat([Buffer.from(type), data]); size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(value)); return Buffer.concat([size, value, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0,255,255,255,255,255,255,0,255,255,255,255,255,255]))), chunk("IEND", Buffer.alloc(0))]);
}
const jpeg = Buffer.from("/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAxAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEsAAQEAAAAAAAAAAAAAAAAAAAAHAQEAAAAAAAAAAAAAAAAAAAAAEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAAgACAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8Av4AP/9k=", "base64");
const webp = Buffer.from("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoCAAIAAgA0JaQAA3AA/vuUAAA=", "base64");
function bmp(): Buffer { const value = Buffer.alloc(70); value.write("BM"); value.writeUInt32LE(value.length, 2); value.writeUInt32LE(54, 10); value.writeUInt32LE(40, 14); value.writeInt32LE(2, 18); value.writeInt32LE(2, 22); value.writeUInt16LE(1, 26); value.writeUInt16LE(24, 28); value.writeUInt32LE(16, 34); value.fill(255, 54); return value; }

// Reproducible CLI/worker acceptance samples. A plain invocation writes only
// this dedicated project directory; no unit tests are registered in this mode.
if (process.argv.includes("--write-fixtures")) {
  const output = path.resolve(process.cwd(), "logs/usability-20261014/document-fixtures-v1");
  await fs.mkdir(output, { recursive: true });
  const { createCanvas } = await import("@napi-rs/canvas"), canvas = createCanvas(900, 200), drawing = canvas.getContext("2d");
  drawing.fillStyle = "white"; drawing.fillRect(0, 0, 900, 200); drawing.fillStyle = "black"; drawing.font = "40px sans-serif";
  drawing.fillText("OCR TEST LOCAL IMAGE 2026", 30, 80); drawing.fillText("Document import sample", 30, 150);
  const samples: Array<[string, Buffer]> = [["文字层样本.pdf", textPdf()], ["扫描样本.pdf", pdf([Buffer.from("q 10 0 0 10 0 0 cm BI /W 1 /H 1 /BPC 8 /CS /G ID \xff EI Q", "latin1")])], ["主文档样本.docx", docx(body("<w:p><w:r><w:t>中文导入验收：保留原文限定语。</w:t></w:r></w:p><w:p><w:r><w:t>DOCX SEARCH SAMPLE 2026</w:t></w:r></w:p>"))], ["原图样本.png", canvas.toBuffer("image/png")], ["原图样本.jpg", jpeg], ["原图样本.webp", webp], ["原图样本.bmp", bmp()]];
  const report = [];
  for (const [name, bytes] of samples) {
    const file = path.join(output, name);
    try { await fs.writeFile(file, bytes, { flag: "wx" }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || sha(await fs.readFile(file)) !== sha(bytes)) throw new Error("fixture already exists with different bytes; preserve it and use a fresh project fixture directory");
    }
    report.push({ file, bytes: bytes.length, sha256: sha(bytes) });
  }
  console.log(JSON.stringify(report, null, 2)); process.exit(0);
}

test("shared queue preflight uses the same extension aliases and hard byte limits as import", () => {
  for (const ext of [".pdf", ".docx", ".png", ".jpg", ".jpeg", ".webp", ".bmp"]) { assert.ok((LOCAL_IMPORT_EXTENSIONS as readonly string[]).includes(ext)); assert.equal(localImportByteLimit(ext), 32 * 1024 * 1024); }
  assert.equal(localImportFormat("photo.JPG"), "jpeg"); assert.equal(localImportFormat(".jpeg"), "jpeg"); assert.equal(localImportByteLimit(".txt"), 8 * 1024 * 1024); assert.equal(localImportByteLimit(".mp4"), 2 * 1024 * 1024 * 1024);
  assert.throws(() => localImportByteLimit(".pdf", { maxDocumentBytes: 33 * 1024 * 1024 }));
});

test("real text-layer PDF extracts searchable text and preserves byte-identical independent original snapshots", async t => {
  const f = await fixture(t), bytes = textPdf(), file = await f.write("文字层.pdf", bytes), before = await fs.stat(file);
  const result = await importLocalFile(file, f.context), repeated = await importLocalFile(file, f.context), original = result.assets[0];
  assert.match(result.markdown, /Original searchable PDF/); assert.match(result.markdown, /Qualifier retained/); assert.equal(result.localSource.document?.textPages, 1); assert.equal(original.mime, "application/pdf"); assert.equal(original.role, "source");
  assert.equal(sha(await fs.readFile(file)), sha(bytes)); assert.equal(original.sha256, sha(bytes)); assert.equal(repeated.localSource.reusedSnapshot, true); assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
  await fs.writeFile(path.join(f.stage, original.path!), "changed copy"); assert.deepEqual(await fs.readFile(file), bytes);
  await assert.rejects(importLocalFile(file, f.context), { code: "SNAPSHOT_INTEGRITY" });
});

test("PDF embedded Unicode mapping extracts Chinese text without fetching fonts or a web resource", async t => {
  const f = await fixture(t), file = await f.write("中文.pdf", pdf([Buffer.from("BT /F1 12 Tf 10 100 Td <00010002> Tj ET")], { chinese: true }));
  assert.match((await importLocalFile(file, f.context)).markdown, /中文/);
});

test("scanned or empty-page PDF retains its original and never claims text-layer or OCR success", async t => {
  const f = await fixture(t);
  for (const stream of [Buffer.from(""), Buffer.from("q 10 0 0 10 0 0 cm BI /W 1 /H 1 /BPC 8 /CS /G ID \xff EI Q", "latin1")]) {
    const file = await f.write("扫描.pdf", pdf([stream])), result = await importLocalFile(file, f.context);
    assert.match(result.markdown, /没有可提取|仅为导入状态/); assert.equal(result.localSource.document?.searchable, false); assert.ok(result.warnings.some(value => /文字层|扫描/.test(value))); assert.equal(result.assets[0].status, "saved"); assert.equal(contentStatus(result), "partial");
  }
});

test("PDF with some pages lacking text marks partial page coverage", async t => {
  const f = await fixture(t), file = await f.write("混合.pdf", pdf([Buffer.from("BT /F1 12 Tf 10 100 Td (Only page one.) Tj ET"), Buffer.alloc(0)]));
  const result = await importLocalFile(file, f.context); assert.equal(result.localSource.document?.pages, 2); assert.equal(result.localSource.document?.textPages, 1); assert.equal(result.localSource.document?.complete, false); assert.equal(contentStatus(result), "partial");
});

test("DOCX main body extracts Chinese, entity literals, paragraphs and table text without executing content", async t => {
  const f = await fixture(t), bytes = docx(body('<w:p><w:r><w:t>中文正文与 &lt;literal&gt; 限定语。</w:t><w:tab/><w:t>制表符。</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格文字</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:del><w:r><w:delText>已删除文字</w:delText></w:r></w:del>')), file = await f.write("原文.docx", bytes);
  const result = await importLocalFile(file, f.context); assert.match(result.markdown, /中文正文与 <literal> 限定语/); assert.match(result.markdown, /表格文字/); assert.match(result.markdown, /\t/); assert.doesNotMatch(result.markdown, /已删除文字/);
  assert.equal(result.localSource.document?.searchable, true); assert.equal(result.assets[0].mime, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"); assert.deepEqual(await fs.readFile(file), bytes); assert.deepEqual(await fs.readFile(path.join(f.stage, result.assets[0].path!)), bytes);
});

test("DOCX external relationships are never read and unindexed stories remain explicit", async t => {
  const f = await fixture(t), canary = await f.write("not-authorized-for-document.txt", "DO_NOT_INCLUDE_THIS_CANARY"), relationship = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="image" Target="file:///${canary.replaceAll("\\", "/")}" TargetMode="External"/></Relationships>`;
  const file = await f.write("外部关系.docx", docx(body("<w:p><w:r><w:t>仅正文。</w:t></w:r></w:p>"), [{ name: "word/_rels/document.xml.rels", data: relationship }, { name: "word/footer1.xml", data: "<footer>not extracted</footer>" }]));
  const result = await importLocalFile(file, f.context); assert.equal(result.markdown, "仅正文。"); assert.doesNotMatch(result.markdown, /CANARY|not extracted/); assert.ok(result.warnings.some(value => /外部/.test(value))); assert.ok(result.warnings.some(value => /页眉页脚/.test(value)));
});

test("empty DOCX body retains an original without claiming extracted text", async t => {
  const f = await fixture(t), file = await f.write("空正文.docx", docx(body("<w:p/>"))), result = await importLocalFile(file, f.context);
  assert.match(result.markdown, /没有可检索文字/); assert.equal(result.assets[0].status, "saved"); assert.equal(result.localSource.document?.searchable, false); assert.equal(contentStatus(result), "partial");
});

test("empty, mislabeled and corrupt PDF/DOCX inputs do not publish successful snapshots", async t => {
  const f = await fixture(t);
  for (const [name, bytes] of [["empty.pdf", Buffer.alloc(0)], ["html.pdf", Buffer.from("<html>not PDF</html>")], ["broken.pdf", Buffer.from("%PDF-1.7\ncorrupt")], ["fake.docx", Buffer.from("not zip")], ["wrong-package.docx", zip([{ name: "readme.txt", data: "not OOXML" }])], ["broken-xml.docx", docx("<w:document>unclosed")]] as const) {
    const file = await f.write(name, bytes); await assert.rejects(importLocalFile(file, f.context)); assert.deepEqual(await fs.readFile(file), bytes);
  }
});

test("encrypted PDF and declared encrypted DOCX are rejected without a password attempt", async t => {
  const f = await fixture(t), encryptedPdf = await f.write("密码.pdf", pdf([Buffer.from("BT /F1 12 Tf (protected) Tj ET")], { encrypted: true }));
  await assert.rejects(importLocalFile(encryptedPdf, f.context), { code: "DOCUMENT_ENCRYPTED" });
  const encryptedDocx = await f.write("加密.docx", zip([{ name: "word/document.xml", data: body(""), encrypted: true }]));
  await assert.rejects(importLocalFile(encryptedDocx, f.context), { code: "DOCUMENT_ENCRYPTED" });
});

test("PDF byte, page and extracted text limits reject before publishing an incomplete index", async t => {
  const f = await fixture(t), file = await f.write("限额.pdf", textPdf());
  await assert.rejects(importLocalFile(file, { ...f.context, maxDocumentBytes: 3 }), { code: "TOO_LARGE" });
  await assert.rejects(importLocalFile(file, { ...f.context, documentLimits: { maxTextBytes: 3 } }), { code: "INDEX_TOO_LARGE" });
  const pages = await f.write("页数.pdf", pdf([Buffer.alloc(0), Buffer.alloc(0)])); await assert.rejects(importLocalFile(pages, { ...f.context, documentLimits: { maxPages: 1 } }), { code: "DOCUMENT_PAGE_LIMIT" });
});

test("DOCX rejects archive traversal, duplicate paths, symlinks and active embeddings", async t => {
  const f = await fixture(t);
  for (const extra of [{ name: "../escape.xml", data: "x" }, { name: "word/document.xml", data: body("") }, { name: "word/link.bin", data: "other", symlink: true }, { name: "word/embeddings/object.bin", data: "active" }]) {
    const file = await f.write("拒绝.docx", docx(body("<w:p><w:r><w:t>正文</w:t></w:r></w:p>"), [extra])); await assert.rejects(importLocalFile(file, f.context));
  }
});

test("DOCX rejects DTD/entity declarations and malformed root instead of reading local entities", async t => {
  const f = await fixture(t), file = await f.write("实体.docx", docx('<!DOCTYPE document [<!ENTITY external SYSTEM "file:///never-read.txt">]>' + body("<w:p><w:r><w:t>&external;</w:t></w:r></w:p>")));
  await assert.rejects(importLocalFile(file, f.context), { code: "DOCUMENT_XML_UNSAFE" });
  const wrong = await f.write("根节点.docx", docx("<not-word>fake body</not-word>")); await assert.rejects(importLocalFile(wrong, f.context), { code: "DOCUMENT_XML_INVALID" });
});

test("DOCX compressed expansion, entry count, CRC and actual size are bounded", async t => {
  const f = await fixture(t), xml = body("<w:p><w:r><w:t>" + "repeated ".repeat(2000) + "</w:t></w:r></w:p>");
  const expanded = await f.write("膨胀.docx", zip([{ name: "[Content_Types].xml", data: contentTypes }, { name: "word/document.xml", data: xml, deflate: true }]));
  await assert.rejects(importLocalFile(expanded, f.context), { code: "DOCUMENT_EXPANSION_LIMIT" });
  const valid = await f.write("条目.docx", docx(body("<w:p/>"))); await assert.rejects(importLocalFile(valid, { ...f.context, documentLimits: { maxZipEntries: 1 } }), { code: "DOCUMENT_ZIP_LIMIT" });
  await assert.rejects(importLocalFile(valid, { ...f.context, documentLimits: { maxExpandedBytes: 64 } }), { code: "DOCUMENT_EXPANSION_LIMIT" });
  const invalidSize = await f.write("伪长度.docx", zip([{ name: "[Content_Types].xml", data: contentTypes }, { name: "word/document.xml", data: body("<w:p/>"), declaredSize: 1 }])); await assert.rejects(importLocalFile(invalidSize, f.context));
  const changed = docx(body("<w:p/>")); changed[30 + Buffer.byteLength("[Content_Types].xml") + 8] ^= 1; const badCrc = await f.write("损坏CRC.docx", changed); await assert.rejects(importLocalFile(badCrc, f.context), { code: "DOCUMENT_ZIP_INTEGRITY" });
});

test("raster PNG/JPEG/WebP/BMP keep original bytes and become offline OCR image sources", async t => {
  const f = await fixture(t);
  for (const [ext, bytes, format] of [["png", png(), "png"], ["jpg", jpeg, "jpeg"], ["jpeg", jpeg, "jpeg"], ["webp", webp, "webp"], ["bmp", bmp(), "bmp"]] as const) {
    const file = await f.write("原图." + ext, bytes), result = await importLocalFile(file, f.context);
    assert.equal(result.kind, "gallery"); assert.equal(result.localSource.format, format); assert.equal(result.localSource.image?.width, 2); assert.equal(result.localSource.image?.height, 2); assert.equal(result.assets[0].role, "image"); assert.equal(result.assets[0].provenance, "original"); assert.equal(result.assets[0].sha256, sha(bytes));
    assert.deepEqual(await fs.readFile(file), bytes); assert.deepEqual(await fs.readFile(path.join(f.stage, result.assets[0].path!)), bytes); assert.equal(result.assets.some(value => value.role === "ocr"), false);
  }
  const a = await importLocalFile(path.join(f.source, "原图.jpg"), f.context), b = await importLocalFile(path.join(f.source, "原图.jpeg"), f.context); assert.equal(a.nativeId, b.nativeId);
});

test("images reject mismatched extensions, truncated payloads, oversized dimensions and bytes", async t => {
  const f = await fixture(t);
  for (const [name, bytes] of [["wrong.jpg", png()], ["broken.png", png().subarray(0, -12)], ["broken.jpg", jpeg.subarray(0, -2)], ["broken.webp", webp.subarray(0, -2)], ["large.png", png(20000, 20000)]] as const) { const file = await f.write(name, bytes); await assert.rejects(importLocalFile(file, f.context)); assert.deepEqual(await fs.readFile(file), bytes); }
  const file = await f.write("小图.png", png()); await assert.rejects(importLocalFile(file, { ...f.context, maxImageBytes: 3 }), { code: "TOO_LARGE" });
});

test("document/image grants still require the exact selected path or a contained authorized directory", async t => {
  const f = await fixture(t), file = await f.write("授权.pdf", textPdf());
  await assert.rejects(importLocalFile(file, { ...f.context, allowedRoot: f.stage }), { code: "NOT_AUTHORIZED" });
  const result = await importLocalFile(file, { runtimeRoot: process.cwd(), directory: f.stage, explicitPath: file }); assert.match(result.markdown, /searchable/);
  await assert.rejects(importLocalFile(path.join(f.source, "missing.png"), { ...f.context, allowedRoot: f.stage }), { code: "NOT_AUTHORIZED" });
});

test("document parser timeout and cancellation terminate workers and leave inputs unchanged", async t => {
  const f = await fixture(t), bytes = textPdf(), file = await f.write("中止.pdf", bytes);
  await assert.rejects(extractDocumentText(file, "pdf", { timeoutMs: 1 }), { code: "DOCUMENT_TIMEOUT" });
  const controller = new AbortController(), job = extractDocumentText(file, "pdf", {}, controller.signal); setTimeout(() => controller.abort(new Error("test cancellation")), 20);
  await assert.rejects(job, /test cancellation/); assert.deepEqual(await fs.readFile(file), bytes);
});

test("DOCX supports BOM UTF16 XML without guessing or losing Chinese words", async t => {
  const f = await fixture(t), xml = Buffer.concat([Buffer.from([255,254]), Buffer.from(body("<w:p><w:r><w:t>中文限定语</w:t></w:r></w:p>"), "utf16le")]);
  const file = await f.write("UTF16.docx", zip([{ name: "[Content_Types].xml", data: contentTypes }, { name: "_rels/.rels", data: rootRelationships }, { name: "word/document.xml", data: xml }])); assert.equal((await importLocalFile(file, f.context)).markdown, "中文限定语");
});

test("DOCX requires its body beneath the actual Word document root", async t => {
  const f = await fixture(t);
  for (const xml of ['<outer>' + body("<w:p/>") + '</outer>', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>']) { const file = await f.write("伪根节点.docx", docx(xml)); await assert.rejects(importLocalFile(file, f.context), { code: "DOCUMENT_XML_INVALID" }); }
});

test("document parsing cannot publish a snapshot changed after the independent copy was verified", async t => {
  const f = await fixture(t), bytes = textPdf(), file = await f.write("输出保护.pdf", bytes);
  await assert.rejects(importLocalFile(file, { ...f.context, onProgress: message => {
    if (!message.includes("文字层")) return;
    const imports = path.join(f.stage, "local-imports"), pending = readdirSync(imports).find(name => name.endsWith(".pending"))!;
    writeFileSync(path.join(imports, pending), pdf([Buffer.from("BT /F1 12 Tf (changed output) Tj ET")]));
  } }), { code: "SNAPSHOT_INTEGRITY" });
  assert.deepEqual(await fs.readFile(file), bytes); assert.equal((await fs.readdir(path.join(f.stage, "local-imports"))).some(name => name.endsWith(".pending")), false);
});

test("DOCX requires a unique local package relationship to its indexed main part", async t => {
  const f = await fixture(t);
  for (const relationships of [rootRelationships.replace('Target="word/document.xml"', 'Target="https://never.invalid/file.xml" TargetMode="External"'), rootRelationships.replace('Target="word/document.xml"', 'Target="other-part.xml"')]) {
    const file = await f.write("错误正文关系.docx", zip([{ name: "[Content_Types].xml", data: contentTypes }, { name: "_rels/.rels", data: relationships }, { name: "word/document.xml", data: body("<w:p><w:r><w:t>伪正文</w:t></w:r></w:p>") }])); await assert.rejects(importLocalFile(file, f.context), { code: "DOCUMENT_ZIP_INVALID" });
  }
});

test("lower ZIP expansion budgets still permit a valid small DOCX within that byte budget", async t => {
  const f = await fixture(t), file = await f.write("小预算.docx", docx(body("<w:p><w:r><w:t>小文档正文</w:t></w:r></w:p>")));
  const result = await importLocalFile(file, { ...f.context, documentLimits: { maxExpandedBytes: 2048 } }); assert.equal(result.markdown, "小文档正文"); assert.ok(result.localSource.document!.expandedBytes! < 2048);
});

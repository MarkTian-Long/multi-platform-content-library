import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const runtimeRoot = process.cwd();
const unitRoot = path.join(runtimeRoot, "logs/local-import-20261014/unit");
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
async function fixture(t: TestContext) {
  await fs.mkdir(unitRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(unitRoot, "case-"));
  const sourceRoot = path.join(directory, "sources"), stage = path.join(directory, "stage");
  await fs.mkdir(sourceRoot); await fs.mkdir(stage);
  t.after(async () => {
    assert.ok(path.relative(unitRoot, directory).startsWith("case-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, sourceRoot, stage, context: { runtimeRoot, directory: stage, allowedRoot: sourceRoot } };
}
const load = () => import("../src/content-local-import.js");

test("imports TXT as an independent byte-identical copy, keeping one snapshot on repeat", async t => {
  const f = await fixture(t), input = path.join(f.sourceRoot, "手记.txt"), text = "中文资料\n第二行，不是简介。\n";
  await fs.writeFile(input, text); const before = await fs.stat(input);
  const { importLocalFile } = await load();
  const first = await importLocalFile(input, f.context), again = await importLocalFile(input, f.context);
  assert.equal(first.platform, "local"); assert.equal(first.kind, "article");
  assert.equal(first.markdown, text); assert.equal(first.nativeId, again.nativeId);
  assert.equal(first.localSource.sha256, digest(text)); assert.equal(again.localSource.reusedSnapshot, true);
  const original = first.assets.find(a => a.provenance === "original")!;
  assert.equal(original.status, "saved"); assert.equal(original.sha256, digest(text));
  assert.equal(await fs.readFile(path.join(f.stage, original.path!), "utf8"), text);
  assert.equal(await fs.readFile(input, "utf8"), text); assert.equal((await fs.stat(input)).mtimeMs, before.mtimeMs);
  await fs.writeFile(path.join(f.stage, original.path!), "changed copied bytes");
  assert.equal(await fs.readFile(input, "utf8"), text, "the staged copy must not share the input inode");
});

test("Markdown body is preserved and identical renamed files keep identity", async t => {
  const f = await fixture(t), text = "# 测试标题\n\n原始 **限定语** 与分组来源。\n\n- A\n- B\n";
  const a = path.join(f.sourceRoot, "a.md"), b = path.join(f.sourceRoot, "改名.markdown");
  await fs.writeFile(a, text); await fs.copyFile(a, b);
  const { importLocalFile } = await load();
  const one = await importLocalFile(a, f.context), two = await importLocalFile(b, f.context);
  assert.equal(one.markdown, text); assert.equal(one.title, "测试标题"); assert.equal(one.nativeId, two.nativeId);
});

test("HTML is parsed without executing scripts or fetching resources; raw bytes stay as text", async t => {
  const f = await fixture(t), input = path.join(f.sourceRoot, "article.html");
  const html = '<html><head><title>静态文章</title><script>globalThis.localImportExecuted=true;fetch("https://never.test")</script><style>body{background:url(https://never.test/x)}</style></head><body><h1>文章正文<script>globalThis.localImportExecuted=true</script></h1><p>真实的中文内容。</p><img src="https://never.test/a.png" alt="示意图"><iframe src="file:///C:/secret"></iframe><a href="javascript:alert(1)">危险链接标签</a><a href="https://example.test/source">参考资料</a></body></html>';
  await fs.writeFile(input, html);
  const { importLocalFile } = await load(), result = await importLocalFile(input, f.context);
  assert.match(result.markdown, /真实的中文内容/); assert.match(result.markdown, /参考资料/);
  assert.equal(result.title, "文章正文");
  assert.doesNotMatch(result.markdown, /localImportExecuted|javascript:|file:\/\/|iframe|background:/);
  assert.equal((globalThis as { localImportExecuted?: boolean }).localImportExecuted, undefined);
  const asset = result.assets.find(a => a.provenance === "original")!;
  assert.ok(asset.path!.endsWith(".html.txt"));
  assert.equal(await fs.readFile(path.join(f.stage, asset.path!), "utf8"), html);
  assert.ok(result.coverage?.body?.includes("静态"));
});

test("accepts BOM UTF16 and explicit legacy Chinese encoding; rejects guessed invalid text", async t => {
  const f = await fixture(t), le = path.join(f.sourceRoot, "utf16.txt"), gb = path.join(f.sourceRoot, "gbk.txt");
  await fs.writeFile(le, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("你好\n", "utf16le")]));
  await fs.writeFile(gb, Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
  const { importLocalFile } = await load();
  assert.equal((await importLocalFile(le, f.context)).markdown, "你好\n");
  await assert.rejects(importLocalFile(gb, f.context), /编码|UTF/);
  assert.equal((await importLocalFile(gb, { ...f.context, textEncoding: "gb18030" })).markdown, "你好");
});

test("requires a root grant or exact explicitly selected path", async t => {
  const f = await fixture(t), input = path.join(f.sourceRoot, "note.txt"); await fs.writeFile(input, "正文");
  const { importLocalFile } = await load();
  await assert.rejects(importLocalFile(input, { runtimeRoot, directory: f.stage }), /授权|白名单/);
  const exact = await importLocalFile(input, { runtimeRoot, directory: f.stage, explicitPath: input });
  assert.match(exact.markdown, /正文/);
  await assert.rejects(importLocalFile(input, { ...f.context, allowedRoot: f.stage }), /授权|白名单/);
  await assert.rejects(importLocalFile(path.join(f.directory, "not-present.txt"), f.context), error => (error as { code?: string }).code === "NOT_AUTHORIZED");
});

test("rejects URLs, relative paths, network/device paths, directories and unsupported formats", async t => {
  const f = await fixture(t), { importLocalFile } = await load();
  for (const name of ["https://example.test/a.txt", "relative.txt", "\\\\server\\share\\a.txt", "\\\\.\\C:\\a.txt"]) await assert.rejects(importLocalFile(name, f.context), /路径/);
  await assert.rejects(importLocalFile(f.sourceRoot, f.context), /普通文件/);
  for (const ext of [".exe", ".doc", ".svg", ".epub"]) {
    const input = path.join(f.sourceRoot, "unsupported" + ext); await fs.writeFile(input, "not imported");
    await assert.rejects(importLocalFile(input, f.context), /不支持/);
  }
});

test("does not publish empty, binary, script-only or oversized text as usable content", async t => {
  const f = await fixture(t), { importLocalFile } = await load();
  for (const [name, bytes] of [["empty.txt", "  \n"], ["binary.txt", Buffer.from([0, 1, 2, 3])], ["only.html", "<title>标题</title><script>fake()</script>"]] as const) {
    const input = path.join(f.sourceRoot, name); await fs.writeFile(input, bytes);
    await assert.rejects(importLocalFile(input, f.context));
  }
  const tooBig = path.join(f.sourceRoot, "large.md"); await fs.writeFile(tooBig, "abcde");
  await assert.rejects(importLocalFile(tooBig, { ...f.context, maxTextBytes: 4 }), /上限|过大/);
});

test("rejects symlinks and linked ancestors even when their targets are allowlisted", async t => {
  const f = await fixture(t), input = path.join(f.sourceRoot, "good.txt"); await fs.writeFile(input, "真实正文");
  const direct = path.join(f.sourceRoot, "linked.txt");
  const linkedDir = path.join(f.directory, "linked-dir");
  let fileLink = true;
  try { await fs.symlink(input, direct, "file"); }
  catch (error) { if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error; fileLink = false; t.diagnostic("Windows session has no file-symlink privilege; real directory junction and linked ancestors remain tested"); }
  await fs.symlink(f.sourceRoot, linkedDir, process.platform === "win32" ? "junction" : "dir");
  const { importLocalFile } = await load();
  if (fileLink) await assert.rejects(importLocalFile(direct, f.context), /链接/);
  await assert.rejects(importLocalFile(linkedDir, { ...f.context, allowedRoot: linkedDir }), /链接/);
  await assert.rejects(importLocalFile(path.join(linkedDir, "good.txt"), { ...f.context, allowedRoot: linkedDir }), /链接/);
});

test("detects source changes and cleans its pending copy instead of returning saved", async t => {
  const f = await fixture(t), input = path.join(f.sourceRoot, "changing.txt"); await fs.writeFile(input, "original source");
  const { importLocalFile } = await load(); let changed = false;
  await assert.rejects(importLocalFile(input, { ...f.context, onProgress: message => { if (!changed && message.includes("复制")) { changed = true; writeFileSync(input, "different source bytes"); } } }), /变化/);
  assert.ok(changed);
  const files = await fs.readdir(path.join(f.stage, "local-imports")).catch(() => []);
  assert.ok(files.every(name => !name.endsWith(".pending")));
});

test("does not trust a corrupted previous snapshot or overwrite it silently", async t => {
  const f = await fixture(t), input = path.join(f.sourceRoot, "good.txt"); await fs.writeFile(input, "完整正文");
  const { importLocalFile } = await load(), first = await importLocalFile(input, f.context);
  const copied = path.join(f.stage, first.assets[0].path!); await fs.writeFile(copied, "损坏");
  await assert.rejects(importLocalFile(input, f.context), /完整性|哈希/);
  assert.equal(await fs.readFile(copied, "utf8"), "损坏"); assert.equal(await fs.readFile(input, "utf8"), "完整正文");
});

test("imports a real WAV with a verified audio stream; does not invent a transcript", async t => {
  const f = await fixture(t), input = path.join(f.sourceRoot, "short.wav"), pcm = Buffer.alloc(3200), header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  await fs.writeFile(input, Buffer.concat([header, pcm]));
  const { importLocalFile } = await load(), result = await importLocalFile(input, f.context);
  assert.equal(result.kind, "audio"); assert.equal(result.assets[0].role, "audio");
  assert.ok(result.parts?.[0].durationSeconds && result.parts[0].durationSeconds > 0);
  assert.equal(result.assets.some(a => a.role === "transcript"), false);
  assert.equal(result.localSource.media?.streams[0].codec_type, "audio");
});

test("rejects fake media/playlist headers before they can be parsed as remote playlists", async t => {
  const f = await fixture(t), { importLocalFile } = await load();
  for (const ext of [".mp4", ".mp3", ".wav"]) {
    const input = path.join(f.sourceRoot, "fake" + ext); await fs.writeFile(input, "#EXTM3U\nhttps://never.test/remote.ts\n");
    await assert.rejects(importLocalFile(input, f.context), /格式|媒体|文件头/);
  }
});

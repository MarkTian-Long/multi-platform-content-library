import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireContent, extractXiaohongshuNoteHtml, writeComments } from "../src/content-acquisition.js";
import { parseContentLinks } from "../src/content-input.js";
import { persistBilibiliCookies } from "../src/content-network.js";

const fixture = await fs.readFile(new URL("./fixtures/content-web.html", import.meta.url), "utf8");

test("captures a public webpage as cleaned markdown and saves public images relative to its content directory", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "content-acquisition-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const original = globalThis.fetch;
  const checkpoints: Array<{ markdown: string; assets: number }> = [];
  globalThis.fetch = (async (url: string | URL) => String(url).includes("image.png")
    ? new Response(Uint8Array.of(137, 80, 78, 71), { headers: { "content-type": "image/png" } })
    : new Response(fixture, { headers: { "content-type": "text/html" } })) as typeof fetch;
  try {
    const captured = await acquireContent(parseContentLinks("https://example.com/research?session=private")[0], { runtimeRoot: directory, directory, onCheckpoint: async (record) => { checkpoints.push({ markdown: record.markdown, assets: record.assets.length }); } });
    assert.equal(captured.platform, "web");
    assert.equal(captured.title, "网页资料标题");
    assert.match(captured.markdown, /这是可离线阅读的正文/);
    assert.match(captured.markdown, /\[参考资料\]\(https:\/\/example\.com\/reference\)/);
    assert.doesNotMatch(captured.markdown, /javascript:|onclick|window\.secret|private/);
    assert.deepEqual(captured.assets.map((asset) => [asset.role, asset.status, asset.path]), [["image", "saved", "images/001.png"]]);
    assert.deepEqual([...await fs.readFile(path.join(directory, "images", "001.png"))], [137, 80, 78, 71]);
    assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.assets), [0, 1]);
    assert.equal(checkpoints.every((checkpoint) => checkpoint.markdown.includes("可离线阅读的正文")), true);
  } finally { globalThis.fetch = original; }
});

test("reports a missing Bilibili downloader as coverage rather than a successful video capture", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "content-acquisition-bili-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const captured = await acquireContent(parseContentLinks("https://www.bilibili.com/video/BV1xx411c7mD")[0], { runtimeRoot: directory, directory });
  assert.equal(captured.kind, "video");
  assert.equal(captured.assets[0]?.status, "missing_dependency");
  assert.equal(captured.coverage?.media, "not_attempted: yt-dlp unavailable");
});

test("uses only Xiaohongshu note content and excludes recommendations while preserving note image order", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "content-acquisition-xhs-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(Uint8Array.of(1), { headers: { "content-type": "image/jpeg" } })) as typeof fetch;
  try {
    const captured = await acquireContent(parseContentLinks("https://www.xiaohongshu.com/explore/66aa11bb22cc33dd44ee55ff")[0], { runtimeRoot: directory, directory }, {
      captureXiaohongshu: async () => ({ finalUrl: "https://www.xiaohongshu.com/explore/66aa11bb22cc33dd44ee55ff", title: "笔记标题", author: "笔记作者", body: "笔记正文", images: ["https://example.com/first.jpg", "https://example.com/second.jpg"], recommendedImages: ["https://example.com/recommended.jpg"], videos: [] })
    });
    assert.equal(captured.title, "笔记标题");
    assert.equal(captured.author, "笔记作者");
    assert.equal(captured.markdown, "笔记正文");
    assert.deepEqual(captured.assets.map((asset) => asset.path), ["images/001.jpg", "images/002.jpg"]);
  } finally { globalThis.fetch = original; }
});

test("maps Bilibili files to parts by info metadata and keeps comments separate from sensitive source metadata", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "content-acquisition-bili-parts-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const commands: string[][] = [];
  const runner = async (_command: string, args: string[], context: { directory: string }) => {
    commands.push(args);
    calls += 1;
    if (calls === 1) return { code: 0, stdout: JSON.stringify({ title: "合集", entries: [{ id: "p1", title: "第一P", duration: 3 }, { id: "p2", title: "第二P", duration: 4 }] }), stderr: "", timedOut: false, cancelled: false, outputTruncated: false };
    const folder = args[args.indexOf("-o") + 1].split("/")[1]; const media = path.join(context.directory, "media", folder); await fs.mkdir(media, { recursive: true });
    if (calls === 2) { await fs.writeFile(path.join(media, "first [p1].mp4"), Uint8Array.of(1)); await fs.writeFile(path.join(media, "first [p1].info.json"), JSON.stringify({ id: "p1", comments: [{ text: "公开评论" }], webpage_url: "https://bilibili.example/?token=secret" })); }
    else await fs.writeFile(path.join(media, "second [p2].m4a"), Uint8Array.of(2));
    return { code: 0, stdout: "", stderr: "", timedOut: false, cancelled: false, outputTruncated: false };
  };
  const captured = await acquireContent(parseContentLinks("https://www.bilibili.com/video/BV1xx411c7mD")[0], { runtimeRoot: directory, directory }, { ytDlpPath: "fake-yt-dlp", runTool: runner, probeMedia: async (file) => file.endsWith(".mp4") ? { video: true, audio: true, durationSeconds: 3 } : { video: false, audio: true, durationSeconds: 4 } });
  assert.deepEqual(captured.parts?.map((part) => [part.id, part.status]), [["p1", "saved"], ["p2", "partial"]]);
  assert.deepEqual(captured.assets.filter((asset) => asset.role === "video").map((asset) => [asset.path?.endsWith("first [p1].mp4"), asset.partId]), [[true, "p1"]]);
  assert.equal(captured.assets.some((asset) => asset.role === "comments" && asset.path?.endsWith(".comments.json")), true);
  assert.equal(captured.assets.some((asset) => asset.sourceUrl?.includes("secret")), false);
  assert.equal(commands.some((args) => args.some((value) => /^media\/[a-f0-9]{24}\//.test(value))), true);
});

test("treats a null yt-dlp metadata document as a failed acquisition instead of throwing", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "content-acquisition-bili-null-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const captured = await acquireContent(parseContentLinks("https://www.bilibili.com/video/BV1xx411c7mD")[0], { runtimeRoot: directory, directory }, { ytDlpPath: "fake", runTool: async () => ({ code: 1, stdout: "null", stderr: "metadata denied", timedOut: false, cancelled: false, outputTruncated: false }) });
  assert.equal(captured.coverage?.metadata, "failed");
  assert.equal(captured.assets[0]?.status, "failed");
});

test("passes the dedicated Bilibili cookie file and hardened flags to metadata and each part download", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "content-acquisition-bili-cookies-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cookie = path.join(directory, ".content-profile", "bilibili", "cookies.txt");
  await fs.mkdir(path.dirname(cookie), { recursive: true }); await fs.writeFile(cookie, "# Netscape HTTP Cookie File\n");
  const commands: string[][] = [];
  const captured = await acquireContent(parseContentLinks("https://www.bilibili.com/video/BV1xx411c7mD")[0], { runtimeRoot: directory, directory }, { ytDlpPath: "fake", runTool: async (_command, args) => { commands.push(args); return commands.length === 1 ? { code: 0, stdout: JSON.stringify({ title: "一P", entries: [{ id: "p1", title: "一P" }] }), stderr: "", timedOut: false, cancelled: false, outputTruncated: false } : { code: 0, stdout: "", stderr: "", timedOut: false, cancelled: false, outputTruncated: false }; } });
  assert.equal(captured.title, "一P");
  assert.equal(commands.length, 2);
  assert.ok(commands[1].includes(`home:${directory}`));
  assert.ok(commands[1].includes(`temp:${path.join(directory,".part")}`));
  assert.ok(!commands[1].includes("--max-downloads"),"A successful per-part download must finish postprocessing instead of exiting 101");
  for (const args of commands) {
    assert.equal(args.includes("--ignore-config"), true); assert.equal(args.includes("--no-plugin-dirs"), true);
    assert.deepEqual(args.slice(args.indexOf("--cookies"), args.indexOf("--cookies") + 2), ["--cookies", cookie]);
  }
});

test("persists only Bilibili profile cookies atomically while the browser context is still alive", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "content-login-cookies-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const saved = await persistBilibiliCookies(root, [{ domain: ".bilibili.com", path: "/", secure: true, expires: -1, name: "SESSDATA", value: "profile-only" }, { domain: ".example.com", path: "/", secure: true, expires: -1, name: "other", value: "must-not-save" }]);
  assert.equal(saved, true);
  const text = await fs.readFile(path.join(root, ".content-profile", "bilibili", "cookies.txt"), "utf8");
  assert.match(text, /SESSDATA/); assert.doesNotMatch(text, /must-not-save/);
});

test("hashes hostile Bilibili part ids before writing independent comments", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "content-comments-safe-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const asset = await writeComments(root, "../../outside", [{ text: "safe" }]);
  assert.match(asset.path ?? "", /^comments\/[a-f0-9]{32}\.comments\.json$/);
  assert.equal(await fs.stat(path.join(root, asset.path ?? "")).then(() => true), true);
  assert.equal(await fs.stat(path.join(root, "outside")).then(() => true).catch(() => false), false);
});

test("extracts Xiaohongshu only from a unique note container and excludes recommendation media", () => {
  const note = extractXiaohongshuNoteHtml('<main><section id="noteContainer"><h1>笔记标题</h1><span class="author">作者</span><div class="note-content">笔记正文</div><img data-src="https://example.com/note.jpg"><video src="https://example.com/note.mp4"></video></section><aside class="recommend"><img src="https://example.com/recommend.jpg">推荐正文</aside></main>', "https://www.xiaohongshu.com/explore/66aa11bb22cc33dd44ee55ff");
  assert.deepEqual(note, { finalUrl: "https://www.xiaohongshu.com/explore/66aa11bb22cc33dd44ee55ff", title: "笔记标题", author: "作者", body: "笔记正文", images: ["https://example.com/note.jpg"], videos: ["https://example.com/note.mp4"] });
});

test("does not mark a probeable Bilibili file saved when its part process exits unsuccessfully", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "content-bili-failed-part-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const captured = await acquireContent(parseContentLinks("https://www.bilibili.com/video/BV1xx411c7mD")[0], { runtimeRoot: directory, directory }, { ytDlpPath: "fake", runTool: async (_command, args, context) => { calls += 1; if (calls === 1) return { code: 0, stdout: JSON.stringify({ title: "一P", entries: [{ id: "p1", title: "一P", duration: 4 }] }), stderr: "", timedOut: false, cancelled: false, outputTruncated: false }; const media = path.join(context.directory, args[args.indexOf("-o") + 1].replace(/\/%\(.+$/, "")); await fs.mkdir(media, { recursive: true }); await fs.writeFile(path.join(media, "one [p1].mp4"), Uint8Array.of(1)); return { code: 1, stdout: "", stderr: "network broken", timedOut: false, cancelled: false, outputTruncated: false }; }, probeMedia: async () => ({ video: true, audio: true, durationSeconds: 4 }) });
  assert.equal(captured.assets.find((asset) => asset.role === "video")?.status, "failed");
  assert.equal(captured.parts?.[0].status, "partial");
});

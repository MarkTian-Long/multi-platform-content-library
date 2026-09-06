import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { acquireContent, extractXiaohongshuNoteHtml } from "../src/content-acquisition.js";
import { parseContentLinks } from "../src/content-input.js";

const xhsUrl = "https://www.xiaohongshu.com/explore/66aa11bb22cc33dd44ee55ff";
const success = (stdout = "") => ({ code: 0, stdout, stderr: "", timedOut: false, cancelled: false, outputTruncated: false });
async function directory(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "content-acquisition-review-"));
  t.after(async () => { if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith("content-acquisition-review-")) await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

test("review: nested Xiaohongshu mask and note represent one note", () => {
  const snapshot = extractXiaohongshuNoteHtml('<div class="note-detail-mask"><div class="note-container"><h1>标题</h1><div class="note-content">真实正文</div><div class="note-media"><img src="https://example.com/note.jpg"></div></div></div>', xhsUrl);
  assert.equal(snapshot.body, "真实正文");
  assert.deepEqual(snapshot.images, ["https://example.com/note.jpg"]);
});

test("review: Xiaohongshu excludes recommendation text, author avatars and comment images", () => {
  const snapshot = extractXiaohongshuNoteHtml('<div id="noteContainer"><div class="author"><img src="https://example.com/avatar.jpg">作者</div><div class="note-content">真实正文<div class="recommend">推荐正文</div></div><div class="note-media"><img src="https://example.com/note.jpg"></div><div class="comments"><img src="https://example.com/comment.jpg"></div></div>', xhsUrl);
  assert.equal(snapshot.body, "真实正文");
  assert.deepEqual(snapshot.images, ["https://example.com/note.jpg"]);
});

test("review: a readable note discussing verification codes is not a login gate", async t => {
  const root = await directory(t);
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const captured = await acquireContent(parseContentLinks(xhsUrl)[0], { runtimeRoot: root, directory: root }, {
    captureXiaohongshu: async () => ({ finalUrl: xhsUrl, title: "验证码技术", body: "本文介绍如何生成验证码，以及登录后产品页面的设计。", images: [], videos: [] })
  });
  assert.match(captured.markdown, /如何生成验证码/);
  assert.equal(captured.assets.some(asset => asset.status === "login_required"), false);
});

test("review: Bilibili retries isolate different part durations and never reclassify machine transcripts or duplicate comments", async t => {
  const root = await directory(t);
  const partDirectory = (id: string) => path.join(root, "media", createHash("sha256").update(id).digest("hex").slice(0, 24));
  await fs.mkdir(partDirectory("p2"), { recursive: true });
  await fs.writeFile(path.join(partDirectory("p2"), "second [p2].mp4"), "previous complete p2");
  await fs.mkdir(path.join(root, "derived", "transcripts"), { recursive: true });
  await fs.writeFile(path.join(root, "derived", "transcripts", "video.asr.srt"), "1\n00:00:00,000 --> 00:00:10,000\n来自本地ASR\n");
  let calls = 0;
  const captured = await acquireContent(parseContentLinks("https://www.bilibili.com/video/BV1xx411c7mD")[0], { runtimeRoot: root, directory: root }, {
    ytDlpPath: "injected-downloader",
    runTool: async (_command, args) => {
      calls++;
      if (calls === 1) return success(JSON.stringify({ title: "两P", entries: [{ id: "p1", title: "一", duration: 10 }, { id: "p2", title: "二", duration: 100 }] }));
      const id = args[args.indexOf("--playlist-items") + 1] === "1" ? "p1" : "p2";
      const folder = path.join(root, args[args.indexOf("-o") + 1].replace(/\/%\(.+$/, ""));
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, `${id === "p1" ? "first" : "second"} [${id}].mp4`), "complete media");
      await fs.writeFile(path.join(folder, `${id} [${id}].info.json`), JSON.stringify({ id, comments: [{ text: `comment of ${id}` }] }));
      return success();
    },
    probeMedia: async file => ({ video: true, audio: true, durationSeconds: file.includes("[p1]") ? 10 : 100 })
  });
  assert.deepEqual(captured.parts?.map(part => [part.id, part.status]), [["p1", "saved"], ["p2", "saved"]]);
  assert.equal(captured.assets.some(asset => asset.path?.startsWith("derived/")), false);
  const comments = captured.assets.filter(asset => asset.role === "comments");
  assert.equal(comments.length, 2);
  assert.equal(new Set(comments.map(asset => asset.id)).size, 2);
  assert.deepEqual(comments.map(asset => asset.partId).sort(), ["p1", "p2"]);
  assert.match(captured.coverage?.["part:p2:duration"] ?? "", /metadata=100s actual=100s/);
});

test("review: a Bilibili part output junction is rejected before invoking a downloader", async t => {
  const root = await directory(t);
  const outside = path.join(root, "outside-output"); await fs.mkdir(outside);
  const stage = path.join(root, "stage"); await fs.mkdir(path.join(stage, "media"), { recursive: true });
  const hash = createHash("sha256").update("p1").digest("hex").slice(0, 24);
  await fs.symlink(outside, path.join(stage, "media", hash), "junction");
  let downloads = 0;
  await acquireContent(parseContentLinks("https://www.bilibili.com/video/BV1xx411c7mD")[0], { runtimeRoot: root, directory: stage }, {
    ytDlpPath: "injected-downloader",
    runTool: async (_command, args) => {
      if (args.includes("--dump-single-json")) return success(JSON.stringify({ title: "一P", entries: [{ id: "p1", title: "一", duration: 10 }] }));
      downloads++;
      const folder = path.join(stage, args[args.indexOf("-o") + 1].replace(/\/%\(.+$/, ""));
      await fs.writeFile(path.join(folder, "unexpected-output.txt"), "must not write through a junction");
      return success();
    }
  }).catch(() => {});
  assert.equal(downloads, 0, "Unsafe output paths must be checked before the external tool writes");
  assert.deepEqual(await fs.readdir(outside), []);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseContentLinks } from "../src/content-input.js";
import { runLinkCli } from "../src/link-cli.js";
import { enqueueInputs, updateJob } from "../src/content-jobs.js";
import { saveContent, contentDirectory, contentIdentity, fileHash, contentStatus } from "../src/content-library.js";
import { processContentJob } from "../src/content-service.js";
import { acquireContent } from "../src/content-acquisition.js";
import type { CapturedContent } from "../src/content-types.js";

async function temporary(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "social-integration-"));
  t.after(async () => { if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith("social-integration-")) await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

for (const url of ["https://www.douyin.com/video/6961737553342991651", "https://weibo.com/7827771738/N4xlMvjhI"]) test("shared acquisition forwards Edge fallback for " + parseContentLinks(url)[0].platform, async t => {
  const root = await temporary(t), input = parseContentLinks(url)[0]; let captures = 0;
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 403 }));
  const captured = await acquireContent(input, { runtimeRoot: root, directory: root }, {
    ytDlpPath: process.execPath,
    runTool: async () => ({ code: 1, stdout: "", stderr: "Fresh cookies needed", timedOut: false, cancelled: false, outputTruncated: false }),
    captureBrowser: async target => { captures++; assert.equal(target.nativeId, input.nativeId); return { finalUrl: input.canonicalUrl, html: "<main>请完成验证</main>", responses: [], gated: true }; },
  });
  assert.equal(captures, 1); assert.equal(captured.platform, input.platform);
  assert.ok(captured.assets.some(asset => asset.status === "login_required"));
});

test("CLI enqueues social shares and deduplicates Weibo aliases without leaking query secrets", async t => {
  const root = await temporary(t);
  const result = await runLinkCli(["enqueue", "抖音 https://douyin.com/video/6961737553342991651?token=SECRET 微博 https://weibo.com/7827771738/N4xlMvjhI https://m.weibo.cn/detail/4910815147462302"], { root });
  assert.equal(result.ok, true); assert.equal(result.addedCount, 2);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  const queue = JSON.parse(await fs.readFile(path.join(root, "queue.json"), "utf8"));
  assert.deepEqual(queue.jobs.map((job: { platform: string }) => job.platform), ["douyin", "weibo"]);
  assert.equal(queue.jobs[1].input.nativeId, "N4xlMvjhI");
});

test("a social post's truncated original body remains partial even if media saved and warnings are absent", () => {
  const record: CapturedContent = { platform: "weibo", nativeId: "N4xlMvjhI", sourceUrl: "https://m.weibo.cn/status/N4xlMvjhI", canonicalUrl: "https://m.weibo.cn/status/N4xlMvjhI", title: "目标帖子", kind: "article", capturedAt: new Date().toISOString(), markdown: "只能取得的正文摘要", warnings: [], assets: [], coverage: { body: "partial: long text unavailable" } };
  assert.equal(contentStatus(record), "partial");
  assert.equal(contentStatus({ ...record, coverage: { body: "saved: full original text" } }), "completed");
});

for (const [url, platform, label] of [["https://douyin.com/video/6961737553342991651", "douyin", "抖音"], ["https://weibo.com/7827771738/N4xlMvjhI", "weibo", "微博"]] as const) {
  test(`${platform} derivative retries use verified originals without fetching expired platform URLs`, async t => {
    const root = await temporary(t), input = parseContentLinks(url)[0];
    const [job] = await enqueueInputs(root, [input]);
    const staging = path.join(root, "staging", job.id); await fs.mkdir(staging, { recursive: true });
    await fs.writeFile(path.join(staging, "original.mp4"), "previously-verified-video-fixture");
    const record: CapturedContent = { ...input, sourceUrl: url, title: "单条资料", kind: "video", capturedAt: new Date().toISOString(), markdown: "目标原文", warnings: [], coverage: { body: "saved: original description" }, parts: [{ id: input.nativeId!, title: "单条", status: "saved" }], assets: [{ id: "video-original", role: "video", status: "saved", path: "original.mp4", provenance: "original" }] };
    const manifest = await saveContent(root, record, staging); const directory = await contentDirectory(root, manifest.contentId);
    assert.match(path.basename(directory), new RegExp(`^${label} - `));
    await fs.unlink(path.join(staging, "original.mp4"));
    await updateJob(root, job.id, { contentId: manifest.contentId, state: "running" });
    let requests = 0; t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("platform must not be fetched during a derivative retry"); });
    const result = await processContentJob(root, root, job, new AbortController().signal, { enrich: async value => value, pdf: async () => undefined });
    assert.equal(result.contentId, contentIdentity(input)); assert.equal(result.state, "partial"); assert.equal(requests, 0);
    const original = manifest.assets.find(asset => asset.role === "video")!;
    assert.equal(await fileHash(path.join(directory, original.path!)), original.sha256);
    const reader = await fs.readFile(path.join(directory, "阅读.html"), "utf8"); assert.match(reader, new RegExp(label));
    assert.equal(input.platform, platform);
  });
}

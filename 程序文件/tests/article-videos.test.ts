import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractRenderedArticle } from "../src/extract-article.js";
import * as videoModule from "../src/article-videos.js";

const articleUrl = "https://mp.weixin.qq.com/s/video-example";
const htmlWith = (body: string) => `<h1 id="activity-name">含视频的文章</h1><div id="js_content">${body}</div>`;

test("retains native videos in reading order without exposing signed playback URLs", () => {
  const article = extractRenderedArticle(htmlWith(`<p>前文</p><video src="https://mpvideo.qpic.cn/first.mp4?auth_key=secret&amp;dis_t=12"></video><p>后文</p><video><source src="https://mpvideo.qpic.cn/second.mp4?auth_info=secret"></video>`), articleUrl);
  assert.equal(article.videos?.length, 2);
  assert.deepEqual(article.videos?.map(({ index, status }) => ({ index, status })), [{ index: 1, status: "not_saved" }, { index: 2, status: "not_saved" }]);
  assert.match(article.markdown, /前文[\s\S]*视频 1：请在原文观看（尚未离线保存）[\s\S]*后文[\s\S]*视频 2：请在原文观看（尚未离线保存）/);
  assert.ok(article.markdown.includes(articleUrl));
  assert.doesNotMatch(JSON.stringify(article), /auth_key|auth_info|dis_t|secret|mpvideo\.qpic/);
});

test("deduplicates signed variants and matching Tencent video identifiers", () => {
  const article = extractRenderedArticle(htmlWith(`<video src="https://mpvideo.qpic.cn/video.mp4?auth_key=one"></video><video src="https://mpvideo.qpic.cn/video.mp4?auth_key=two"></video><mp-video vid="v123"></mp-video><iframe src="https://v.qq.com/iframe/player.html?vid=v123&amp;auto=0"></iframe>`), articleUrl);
  assert.equal(article.videos?.length, 2);
  assert.equal(article.videos?.[1].videoId, "v123");
  assert.equal(article.markdown.match(/视频 1：/g)?.length, 2);
  assert.equal(article.markdown.match(/视频 2：/g)?.length, 2);
});

test("keeps the validated player container video ID when its refreshed media URL drops vid", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reader-video-container-id-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const playerWith = (url: string) => htmlWith(`<span class="video_iframe" id="js_mp_video_container_0" vid="wxv_stable"><video src="${url}"></video></span>`);
  const first = extractRenderedArticle(playerWith("https://mpvideo.qpic.cn/initial.mp4?vid=wxv_stable"), articleUrl);
  const refreshed = extractRenderedArticle(playerWith("https://mpvideo.qpic.cn/refreshed.mp4"), articleUrl);
  assert.equal(first.videos?.[0].videoId, "wxv_stable");
  assert.equal(refreshed.videos?.[0].videoId, "wxv_stable");
  assert.equal(refreshed.videos?.[0].sourceKey, first.videos?.[0].sourceKey);
  const existingVideos = await videoModule.downloadArticleVideos(first, directory, async () => new Response(new Uint8Array(4), { headers: { "content-type": "video/mp4" } }));
  const saved = await videoModule.downloadArticleVideos(refreshed, directory, async () => { throw new Error("must reuse the same stable video"); }, { existingVideos });
  assert.equal(saved[0].status, "saved");
  assert.equal(saved[0].bytes, 4);
});

test("keeps distinct player container IDs separate even if their media URLs match", () => {
  const article = extractRenderedArticle(htmlWith(`<span class="video_iframe" id="js_mp_video_container_0" vid="wxv_first"><video src="https://mpvideo.qpic.cn/shared.mp4"></video></span><span class="video_iframe" id="js_mp_video_container_1" data-vid="wxv_second"><video src="https://mpvideo.qpic.cn/shared.mp4"></video></span>`), articleUrl);
  assert.deepEqual(article.videos?.map(({ videoId }) => videoId), ["wxv_first", "wxv_second"]);
  assert.notEqual(article.videos?.[0].sourceKey, article.videos?.[1].sourceKey);
});

test("downloads the current media URL after a stable player container refresh", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reader-video-refreshed-src-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const refreshedUrl = "https://mpvideo.qpic.cn/refreshed.mp4?auth_key=fresh";
  const article = extractRenderedArticle(htmlWith(`<span class="video_iframe" id="js_mp_video_container_0" vid="wxv_stable"><video src="${refreshedUrl}"></video></span>`), articleUrl);
  const requested: string[] = [];
  const saved = await videoModule.downloadArticleVideos(article, directory, async (url) => {
    requested.push(url);
    return new Response(new Uint8Array(4), { headers: { "content-type": "video/mp4" } });
  });
  assert.deepEqual(requested, [refreshedUrl]);
  assert.equal(saved[0].videoId, "wxv_stable");
  assert.equal(saved[0].status, "saved");
  assert.doesNotMatch(JSON.stringify(saved), /auth_key|fresh|mpvideo/);
});

test("recognizes only known video iframe endpoints and keeps unsupported media visible", () => {
  const article = extractRenderedArticle(htmlWith(`<iframe src="https://example.com/embed"></iframe><iframe src="https://mp.weixin.qq.com/mp/videoplayer?vid=w123"></iframe><iframe src="https://v.qq.com.evil.test/iframe/player.html?vid=fake"></iframe><video src="blob:https://mp.weixin.qq.com/a"></video>`), articleUrl);
  assert.equal(article.videos?.length, 2);
  assert.equal(article.videos?.[0].videoId, "w123");
  assert.match(article.markdown, /视频 2：请在原文观看/);
  assert.doesNotMatch(article.markdown, /evil|example\.com/);
});

test("ignores video elements outside the article and numbers unique articles deterministically", () => {
  const article = extractRenderedArticle(`<video src="https://mpvideo.qpic.cn/header.mp4"></video>${htmlWith(`<video data-src="//mpvideo.qpic.cn/body.mp4?auth_key=one"></video>`)}`, articleUrl);
  assert.deepEqual(article.videos?.map(({ index, provider }) => ({ index, provider })), [{ index: 1, provider: "wechat" }]);
  assert.equal(article.status, "complete");
});

test("saves a direct video stream and rewrites the original placeholder to a local file link", async (t) => {
  assert.equal(typeof videoModule.downloadArticleVideos, "function", "video downloading must be implemented");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reader-video-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const article = extractRenderedArticle(htmlWith(`<p>开头</p><video src="https://mpvideo.qpic.cn/first.mp4?auth_key=secret"></video><p>结尾</p>`), articleUrl);
  const requested: string[] = [];
  const saved = await videoModule.downloadArticleVideos(article, directory, async (url, options) => {
    requested.push(url);
    assert.equal(options?.redirect, "manual");
    assert.equal((options?.headers as Record<string, string>)?.Referer, articleUrl);
    return new Response(Uint8Array.of(0, 0, 0, 24, 102, 116, 121, 112), { headers: { "content-type": "video/mp4" } });
  });
  assert.equal(requested.length, 1);
  assert.equal(saved[0].status, "saved");
  assert.equal(saved[0].localPath, "videos/001.mp4");
  assert.equal((await fs.stat(path.join(directory, "001.mp4"))).size, 8);
  const markdown = videoModule.renderVideoMarkdown(article.markdown, saved);
  assert.match(markdown, /开头[\s\S]*\[视频 1：打开本地视频文件\]\(videos\/001\.mp4\)[\s\S]*结尾/);
  assert.doesNotMatch(markdown + JSON.stringify(saved), /auth_key|secret|mpvideo/);
});

test("rejects videos whose streamed size differs from Content-Length and removes incomplete files", async (t) => {
  for (const announcedBytes of [8, 2]) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reader-video-length-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const article = extractRenderedArticle(htmlWith(`<video src="https://mpvideo.qpic.cn/a.mp4"></video>`), articleUrl);
    const saved = await videoModule.downloadArticleVideos(article, directory, async () => new Response(new Uint8Array(4), {
      headers: { "content-type": "video/mp4", "content-length": String(announcedBytes) }
    }));
    assert.equal(saved[0].status, "failed", `a ${announcedBytes}-byte response must not accept 4 bytes`);
    assert.match(saved[0].reason ?? "", /完整|长度/);
    assert.equal(saved[0].localPath, undefined);
    assert.deepEqual(await fs.readdir(directory), []);
  }
});

test("rejects partial or unverified HTTP 206 video ranges instead of saving them as complete videos", async (t) => {
  for (const contentRange of ["bytes 0-3/8", "bytes 4-7/8", "bytes 0-3/*", "invalid", undefined]) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reader-video-range-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const article = extractRenderedArticle(htmlWith(`<video src="https://mpvideo.qpic.cn/a.mp4"></video>`), articleUrl);
    const headers: Record<string, string> = { "content-type": "video/mp4", "content-length": "4" };
    if (contentRange !== undefined) headers["content-range"] = contentRange;
    const saved = await videoModule.downloadArticleVideos(article, directory, async () => new Response(new Uint8Array(4), { status: 206, headers }));
    assert.equal(saved[0].status, "failed", `range ${contentRange ?? "missing"} must not be treated as a whole video`);
    assert.match(saved[0].reason ?? "", /完整|片段/);
    assert.deepEqual(await fs.readdir(directory), []);
  }
});

test("retains complete HTTP 200 and verified full HTTP 206 video responses", async (t) => {
  for (const status of [200, 206]) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reader-video-complete-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const article = extractRenderedArticle(htmlWith(`<video src="https://mpvideo.qpic.cn/a.mp4"></video>`), articleUrl);
    const headers: Record<string, string> = { "content-type": "video/mp4", "content-length": "4" };
    if (status === 206) headers["content-range"] = "bytes 0-3/4";
    const saved = await videoModule.downloadArticleVideos(article, directory, async () => new Response(Uint8Array.of(1, 2, 3, 4), { status, headers }));
    assert.equal(saved[0].status, "saved");
    assert.equal(saved[0].bytes, 4);
    assert.deepEqual([...await fs.readFile(path.join(directory, "001.mp4"))], [1, 2, 3, 4]);
  }
});

test("does not compare decoded response bytes with the compressed Content-Length", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reader-video-decoded-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const article = extractRenderedArticle(htmlWith(`<video src="https://mpvideo.qpic.cn/a.mp4"></video>`), articleUrl);
  // Fetch returns decoded bytes while retaining the original compressed response headers.
  const saved = await videoModule.downloadArticleVideos(article, directory, async () => new Response(new Uint8Array(4), {
    headers: { "content-type": "video/mp4", "content-encoding": "gzip", "content-length": "24" }
  }));
  assert.equal(saved[0].status, "saved");
  assert.equal(saved[0].bytes, 4);
});

test("requires the full HTTP 206 range size even when Content-Length is absent", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reader-video-range-length-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const article = extractRenderedArticle(htmlWith(`<video src="https://mpvideo.qpic.cn/a.mp4"></video>`), articleUrl);
  const saved = await videoModule.downloadArticleVideos(article, directory, async () => new Response(new Uint8Array(4), {
    status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-7/8" }
  }));
  assert.equal(saved[0].status, "failed");
  assert.match(saved[0].reason ?? "", /完整|长度/);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("rejects untrusted video hosts, HLS, blob playback and login pages while preserving the article", async (t) => {
  assert.equal(typeof videoModule.downloadArticleVideos, "function");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reader-video-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const article = extractRenderedArticle(htmlWith(`<video src="https://mpvideo.qpic.cn.evil.test/a.mp4"></video><video src="https://mpvideo.qpic.cn/a.m3u8"></video><video src="blob:https://mp.weixin.qq.com/a"></video><video src="https://mpvideo.qpic.cn/b.mp4"></video>`), articleUrl);
  let requests = 0;
  const saved = await videoModule.downloadArticleVideos(article, directory, async () => { requests += 1; return new Response("<html>login</html>", { headers: { "content-type": "text/html" } }); });
  assert.equal(requests, 1);
  assert.deepEqual(saved.map(({ status }) => status), ["unsupported", "unsupported", "unsupported", "failed"]);
  assert.equal(await fs.readdir(directory).then((files) => files.length), 0);
  assert.equal(videoModule.renderVideoMarkdown(article.markdown, saved), article.markdown);
});

test("enforces announced and streaming video sizes and removes partial files", async (t) => {
  assert.equal(typeof videoModule.downloadArticleVideos, "function");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reader-video-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const article = extractRenderedArticle(htmlWith(`<video src="https://mpvideo.qpic.cn/a.mp4"></video><video src="https://mpvideo.qpic.cn/b.mp4"></video>`), articleUrl);
  let cancelled = false;
  const saved = await videoModule.downloadArticleVideos(article, directory, async (url) => {
    if (url.includes("/a.mp4")) return new Response(new Uint8Array(1), { headers: { "content-type": "video/mp4", "content-length": "1000" } });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4)); controller.enqueue(new Uint8Array(5)); }, cancel() { cancelled = true; } }), { headers: { "content-type": "video/mp4" } });
  }, { maxVideoBytes: 8 });
  assert.deepEqual(saved.map(({ status }) => status), ["failed", "failed"]);
  assert.ok(cancelled);
  assert.equal((await fs.readdir(directory)).length, 0);
});

test("limits total streamed bytes, simultaneous downloads and article video count", async (t) => {
  assert.equal(typeof videoModule.downloadArticleVideos, "function");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reader-video-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const article = extractRenderedArticle(htmlWith(Array.from({ length: 5 }, (_, i) => `<video src="https://mpvideo.qpic.cn/${i}.mp4"></video>`).join("")), articleUrl);
  let active = 0;
  let maxActive = 0;
  let requests = 0;
  const saved = await videoModule.downloadArticleVideos(article, directory, async () => {
    active += 1; requests += 1; maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return new Response(new Uint8Array(4), { headers: { "content-type": "video/mp4" } });
  }, { maxTotalBytes: 8, maxVideos: 3 });
  assert.ok(maxActive <= 2);
  assert.ok(requests <= 3);
  assert.equal(saved.filter(({ status }) => status === "saved").length, 2);
  assert.equal(saved.length, 5);
  assert.ok(saved.slice(3).every(({ reason }) => reason?.includes("数量")));
  const totalSaved = (await Promise.all((await fs.readdir(directory)).map(async (file) => (await fs.stat(path.join(directory, file))).size))).reduce((sum, size) => sum + size, 0);
  assert.equal(totalSaved, 8);
});

test("blocks redirects to local addresses and sanitizes network errors", async (t) => {
  assert.equal(typeof videoModule.downloadArticleVideos, "function");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reader-video-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const article = extractRenderedArticle(htmlWith(`<video src="https://mpvideo.qpic.cn/a.mp4?auth_key=private"></video><video src="https://mpvideo.qpic.cn/b.mp4?auth_info=private"></video>`), articleUrl);
  const requested: string[] = [];
  const saved = await videoModule.downloadArticleVideos(article, directory, async (url) => {
    requested.push(url);
    if (url.includes("/a.mp4")) return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
    throw new Error(`failed fetch ${url}`);
  });
  assert.equal(requested.length, 2);
  assert.ok(requested.every((url) => url.startsWith("https://mpvideo.qpic.cn/")));
  assert.ok(saved.every(({ status }) => status === "failed"));
  assert.doesNotMatch(JSON.stringify(saved), /private|auth_|127\.0\.0\.1|mpvideo/);
});

test("removes video playback credentials from the stored HTML snapshot", () => {
  assert.equal(typeof videoModule.sanitizeArticleVideoHtml, "function");
  const html = `<script>const src="https://mpvideo.qpic.cn/a.mp4?auth_key=private";</script>${htmlWith(`<p>保留正文</p><video src="https://mpvideo.qpic.cn/a.mp4?auth_info=private"></video>`)}`;
  const sanitized = videoModule.sanitizeArticleVideoHtml(html, articleUrl);
  assert.match(sanitized, /保留正文/);
  assert.match(sanitized, /data-article-video-index="1"/);
  assert.match(sanitized, /视频 1：请在原文观看/);
  assert.doesNotMatch(sanitized, /auth_|private|mpvideo|<script/);
});

test("does not overwrite or remove a video file that already exists", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reader-video-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "001.mp4"), "existing user video");
  const article = extractRenderedArticle(htmlWith(`<video src="https://mpvideo.qpic.cn/a.mp4"></video>`), articleUrl);
  const saved = await videoModule.downloadArticleVideos(article, directory, async () => new Response(new Uint8Array(4), { headers: { "content-type": "video/mp4" } }));
  assert.equal(saved[0].status, "failed");
  assert.equal(await fs.readFile(path.join(directory, "001.mp4"), "utf8"), "existing user video");
});

test("times out stalled downloads and retains a safe original article link", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reader-video-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const article = extractRenderedArticle(htmlWith(`<video src="https://mpvideo.qpic.cn/a.mp4?auth_key=secret"></video>`), articleUrl);
  const saved = await videoModule.downloadArticleVideos(article, directory, async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted auth_key=secret", "AbortError")), { once: true });
  }), { timeoutMs: 10 });
  assert.equal(saved[0].status, "failed");
  assert.match(saved[0].reason ?? "", /超时/);
  assert.doesNotMatch(JSON.stringify(saved), /auth_key|secret/);
  assert.equal(videoModule.renderVideoMarkdown(article.markdown, saved), article.markdown);
});

test("uses a one-minute per-video timeout by default", () => {
  assert.equal(videoModule.VIDEO_DOWNLOAD_LIMITS.timeoutMs, 60_000);
});

test("reuses a previously saved matching video while refreshing expired playback candidates", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reader-video-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = extractRenderedArticle(htmlWith(`<video src="https://mpvideo.qpic.cn/a.mp4?auth_key=old"></video>`), articleUrl);
  const existingVideos = await videoModule.downloadArticleVideos(first, directory, async () => new Response(new Uint8Array(4), { headers: { "content-type": "video/mp4" } }));
  const second = extractRenderedArticle(htmlWith(`<video src="https://mpvideo.qpic.cn/a.mp4?auth_key=new"></video>`), articleUrl);
  let requests = 0;
  const saved = await videoModule.downloadArticleVideos(second, directory, async () => { requests += 1; throw new Error("must reuse"); }, { existingVideos });
  assert.equal(requests, 0);
  assert.equal(saved[0].status, "saved");
  assert.equal(saved[0].bytes, 4);
  assert.doesNotMatch(JSON.stringify(saved), /auth_key|mpvideo|old|new/);
});

test("does not reuse a different video at the same article position", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reader-video-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = extractRenderedArticle(htmlWith(`<video src="https://mpvideo.qpic.cn/a.mp4"></video>`), articleUrl);
  const existingVideos = await videoModule.downloadArticleVideos(first, directory, async () => new Response(Uint8Array.of(1, 2, 3, 4), { headers: { "content-type": "video/mp4" } }));
  const second = extractRenderedArticle(htmlWith(`<video src="https://mpvideo.qpic.cn/replacement.mp4"></video>`), articleUrl);
  assert.notEqual(second.videos?.[0].sourceKey, existingVideos[0].sourceKey);
  const saved = await videoModule.downloadArticleVideos(second, directory, async () => new Response(new Uint8Array(4), { headers: { "content-type": "video/mp4" } }), { existingVideos });
  assert.equal(saved[0].status, "failed");
  assert.deepEqual([...await fs.readFile(path.join(directory, "001.mp4"))], [1, 2, 3, 4]);
});

test("replaces the observed WeChat player container without leaking controls or deleting surrounding article text", async () => {
  const html = await fs.readFile(new URL("./fixtures/wechat-video-player.html", import.meta.url), "utf8");
  const article = extractRenderedArticle(html, articleUrl);
  assert.equal(article.videos?.length, 1);
  assert.equal(article.markdown.match(/视频 1：/g)?.length, 1);
  assert.doesNotMatch(article.markdown, /关注|倍速|进度条|分享/);
  assert.match(article.markdown, /容器外的前文[\s\S]*同一个 section 中的视频说明[\s\S]*视频 1：[\s\S]*同一个 section 中的后续解释[\s\S]*普通 div 中的正文仍须保留[\s\S]*没有视频的容器仍须保留[\s\S]*容器外的后文/);
  const sanitized = videoModule.sanitizeArticleVideoHtml(html, articleUrl);
  assert.doesNotMatch(sanitized, /关注|倍速|进度条|分享|auth_key|js_mp_video_container_0/);
  assert.match(sanitized, /data-article-video-index="1"/);
  assert.match(sanitized, /同一个 section 中的后续解释/);
});

test("cleans player controls from a previously sanitized snapshot while retaining its existing placeholder", () => {
  const html = htmlWith(`<section><p>前文</p><span class="video_iframe rich_pages" id="js_mp_video_container_0"><div>倍速</div><div><p data-article-video-index="1"><a href="${articleUrl}">视频 1：请在原文观看（尚未离线保存）</a></p></div><div>进度条</div></span><p>后文</p></section>`);
  const sanitized = videoModule.sanitizeArticleVideoHtml(html, articleUrl);
  assert.doesNotMatch(sanitized, /倍速|进度条|js_mp_video_container_0/);
  assert.equal(sanitized.match(/data-article-video-index="1"/g)?.length, 1);
  assert.match(sanitized, /前文[\s\S]*视频 1：[\s\S]*后文/);
});

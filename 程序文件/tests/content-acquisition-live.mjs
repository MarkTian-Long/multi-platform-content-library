import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseContentLinks, resolveContentInput } from "../src/content-input.js";
import { acquireContent } from "../src/content-acquisition.js";
import { captureSocialBrowser } from "../src/content-social-browser.js";
import { weiboPostReference } from "../src/content-social-reference.js";
import { load } from "cheerio";

const supplied = process.argv[2] ?? "https://example.com/";
const inputs = parseContentLinks(supplied);
if (inputs.length !== 1) throw new Error("请只传入一个公开 HTTP(S) 链接");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "content-acquisition-live-"));
const runtimeRoot = process.env.CONTENT_RUNTIME_ROOT ? path.resolve(process.env.CONTENT_RUNTIME_ROOT) : directory;
const started = Date.now();
try {
  const input = await resolveContentInput(inputs[0]);
  const context = { runtimeRoot, directory, signal: AbortSignal.timeout(150000), onProgress: message => console.log(message) };
  let report;
  if (process.argv.includes("--browser")) {
    const post = weiboPostReference(input.canonicalUrl);
    const requests = input.platform === "douyin" ? [{ url: `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${input.nativeId}` }] : input.platform === "weibo" && post?.kind === "post" ? [{ url: `https://weibo.com/ajax/statuses/show?id=${post.bid}` }, { url: `https://m.weibo.cn/statuses/show?id=${post.mid}` }, { url: `https://weibo.com/ajax/statuses/longtext?id=${post.bid}` }, { url: `https://m.weibo.cn/statuses/extend?id=${post.mid}` }] : [];
    const snapshot = await captureSocialBrowser(input, context, requests), $ = load(snapshot.html);
    const location = new URL(snapshot.finalUrl);
    report = { at: new Date().toISOString(), platform: input.platform, nativeId: input.nativeId, anonymousRuntime: runtimeRoot === directory, finalPage: `${location.origin}${location.pathname}`, gated: snapshot.gated, htmlBytes: Buffer.byteLength(snapshot.html), title: $("title").text(), textPreview: $("body").clone().find("script,style").remove().end().text().replace(/https?:\/\/\S+/g, "[URL]").replace(/\s+/g, " ").slice(0, 400), responseCount: snapshot.responses.length, responseShapes: snapshot.responses.map(response => {
      const target = response.data?.aweme_detail ?? response.data?.data ?? response.data;
      return { endpoint: new URL(response.url).pathname, keys: response.data && typeof response.data === "object" ? Object.keys(response.data).slice(0, 12) : [], statusCode: response.data?.status_code, detailPresent: !!response.data?.aweme_detail, targetId: target?.aweme_id ?? target?.mblogid ?? target?.idstr, videoPresent: !!target?.video || !!target?.page_info?.media_info };
    }) };
  } else {
    const captured = await acquireContent(input, context);
    report = { at: new Date().toISOString(), anonymousRuntime: runtimeRoot === directory, platform: captured.platform, canonicalUrl: captured.canonicalUrl, title: captured.title, kind: captured.kind, assets: captured.assets.map(({ role, status, path, bytes, sha256, reason }) => ({ role, status, path, bytes, sha256, reason })), coverage: captured.coverage, warnings: captured.warnings };
  }
  report.elapsedMs = Date.now() - started;
  console.log(JSON.stringify(report, null, 2));
  if (process.env.CONTENT_LIVE_REPORT) { const file = path.resolve(process.env.CONTENT_LIVE_REPORT); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(report, null, 2) + "\n"); }
} finally {
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("content-acquisition-live-")) throw new Error("Refusing to remove an unexpected live-test directory");
  await fs.rm(directory, { recursive: true, force: true });
}

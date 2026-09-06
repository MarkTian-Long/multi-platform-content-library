import fs from "node:fs/promises";
import path from "node:path";
import { parseContentLinks } from "../src/content-input.js";
import { enqueueInputs,retryJob } from "../src/content-jobs.js";
import { runContentQueue, listSavedContent } from "../src/content-service.js";
import { readContent, exportContent, contentFile } from "../src/content-library.js";
import { runContentTool } from "../src/content-tools.js";

const runtimeRoot = path.resolve(process.cwd());
const libraryRoot = path.resolve(process.env.CONTENT_LIBRARY_ROOT ?? path.join(runtimeRoot, "logs", "link-bilibili-live", "library"));
process.env.WECHAT_ARTICLE_LIBRARY_ROOT=path.join(runtimeRoot,"logs","link-bilibili-live","empty-legacy");
const input = parseContentLinks("https://www.bilibili.com/video/BV1NJ411C77L/");
const queued = await enqueueInputs(libraryRoot, input);
for(const job of queued)if(!["queued","running"].includes(job.state))await retryJob(libraryRoot,job.id);
const jobs = await runContentQueue(runtimeRoot, libraryRoot);
const job = jobs.find(item => item.id === queued[0]?.id) ?? jobs.at(-1);
const items = await listSavedContent(runtimeRoot, libraryRoot);
const item = job?.contentId ? items.find(value => value.contentId === job.contentId) : undefined;
let read = null, exported = null, probes = [];
if (item) {
  read = await readContent(libraryRoot, item.contentId);
  exported = await exportContent(libraryRoot, item.contentId);
  if (read.ok) for (const asset of read.manifest.assets.filter(asset => asset.role === "video" && asset.status === "saved" && asset.path)) {
    const file = await contentFile(libraryRoot, item.contentId, asset.path);
    const result = await runContentTool({ command: path.join(runtimeRoot, "tools", "ffprobe.exe"), args: ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file], cwd: runtimeRoot, timeoutMs: 60_000, maxOutputBytes: 64 * 1024 });
    probes.push({ path: asset.path, code: result.code, stdout: result.stdout, stderr: result.stderr });
  }
}
const report = { capturedAt: new Date().toISOString(), runtimeRoot, libraryRoot, queued, job, item, read: read?.ok ? { total: read.total, manifest: read.manifest } : read, exported, probes };
await fs.mkdir(path.dirname(path.resolve("logs/link-bilibili-live/result.json")), { recursive: true });
await fs.writeFile("logs/link-bilibili-live/result.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({capturedAt:report.capturedAt,job:report.job,probes:report.probes,assets:report.read?.manifest?.assets.reduce((counts,asset)=>{const key=`${asset.role}:${asset.status}`;counts[key]=(counts[key]??0)+1;return counts;},{}),exported}));
if(!probes.length)process.exitCode=1;

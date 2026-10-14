import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { listSavedContent, processContentJob } from "../src/content-service.js";
import { saveContent, readContent, renderContentHtml, fileHash } from "../src/content-library.js";
import { enqueueInputs, getJobs, cancelJob } from "../src/content-jobs.js";
import { enrichContent } from "../src/content-enrichment.js";
import { runLinkCli } from "../src/link-cli.js";
import type { CapturedContent, ContentInput } from "../src/content-types.js";
import * as cheerio from "cheerio";

async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "content-review-repairs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const input = (name: string): ContentInput => ({ platform: "web", url: `https://example.com/review/${name}`, canonicalUrl: `https://example.com/review/${name}` });
const record = (name: string): CapturedContent => ({ ...input(name), sourceUrl: input(name).url, title: name, capturedAt: "2026-10-14T00:00:00Z", kind: "article", markdown: "正式原文", assets: [], warnings: [] });

test("listing during a live worker does not import or overwrite legacy content", async t => {
  const f = await fixture(t), root = path.join(f, "library"), legacy = path.join(f, "legacy"), article = path.join(legacy, "article");
  await fs.mkdir(article, { recursive: true }); await fs.mkdir(root);
  await fs.writeFile(path.join(article, "article.md"), "旧版正文");
  await fs.writeFile(path.join(article, "manifest.json"), JSON.stringify({ articleId: "b".repeat(24), title: "旧版", sourceUrl: "https://mp.weixin.qq.com/s/review-lock", status: "complete", extractedAt: "2026-10-01T00:00:00Z", contentHash: "fixture", markdownFile: "article.md", images: [], videos: [] }));
  const token = "test-owner"; await fs.writeFile(path.join(root, "worker.lock"), JSON.stringify({ pid: process.pid, token }));
  const old = process.env.WECHAT_ARTICLE_LIBRARY_ROOT; process.env.WECHAT_ARTICLE_LIBRARY_ROOT = legacy;
  try {
    assert.deepEqual(await listSavedContent(f, root), [], "search must defer the writer while the worker owns the mutex");
    assert.equal(JSON.parse(await fs.readFile(path.join(root, "worker.lock"), "utf8")).token, token);
    await fs.unlink(path.join(root, "worker.lock"));
    const imported = await listSavedContent(f, root); assert.equal(imported.length, 1); assert.equal(imported[0].title, "旧版");
  } finally { if (old === undefined) delete process.env.WECHAT_ARTICLE_LIBRARY_ROOT; else process.env.WECHAT_ARTICLE_LIBRARY_ROOT = old; }
});

async function reusableAssets(t: any, name: string) {
  const f = await fixture(t), root = path.join(f, "library"), stage = path.join(f, "source"); await fs.mkdir(stage);
  const r = record(name);
  for (let i = 1; i <= 3; i++) { const file = `asset-${i}.bin`; await fs.writeFile(path.join(stage, file), Buffer.alloc(16 * 1024, i)); r.assets.push({ id: `asset-${i}`, role: "image", status: "saved", path: file, provenance: "original" }); }
  const manifest = await saveContent(root, r, stage), [job] = await enqueueInputs(root, [input(name)]);
  return { f, root, stage, r, manifest, job };
}

test("cancellation during restore stops before the next asset and keeps the saved original", async t => {
  const { root, manifest, job } = await reusableAssets(t, "cancel-restore");
  const controller = new AbortController(), originalCopy = fs.copyFile; let copies = 0, acquired = false;
  fs.copyFile = async (from, to, ...rest) => { if (String(to).startsWith(path.join(root, "staging", job.id))) { copies++; if (copies === 1) controller.abort(); } return originalCopy(from, to, ...rest); };
  try {
    await assert.rejects(processContentJob("unused", root, job, controller.signal, { resolve: async i => i, acquire: async (_i, c) => { acquired = true; return c.existing!; }, enrich: async r => r, pdf: async () => undefined }), { name: "AbortError" });
  } finally { fs.copyFile = originalCopy; }
  assert.equal(copies, 1); assert.equal(acquired, false);
  const saved = await readContent(root, manifest.contentId); assert.equal(saved.ok, true); if (saved.ok) assert.equal(saved.text, "正式原文");
});

test("a retry reuses matching restored files without copying them again", async t => {
  const { root, job } = await reusableAssets(t, "matching-stage");
  const deps = { resolve: async (i: ContentInput) => i, acquire: async (_i: ContentInput, c: any) => c.existing, enrich: async (r: CapturedContent) => r, pdf: async () => undefined };
  await processContentJob("unused", root, job, new AbortController().signal, deps);
  const originalCopy = fs.copyFile; let copies = 0;
  fs.copyFile = async (from, to, ...rest) => { if (String(to).startsWith(path.join(root, "staging", job.id))) copies++; return originalCopy(from, to, ...rest); };
  try { const result = await processContentJob("unused", root, job, new AbortController().signal, deps); assert.equal(result.state, "completed"); } finally { fs.copyFile = originalCopy; }
  assert.equal(copies, 0);
});

async function ocrFixture(t: any) {
  const f = await fixture(t), directory = path.join(f, "content"), runtimeRoot = path.join(f, "runtime");
  await fs.mkdir(path.join(directory, "derived", "ocr"), { recursive: true }); await fs.mkdir(path.join(runtimeRoot, "scripts"), { recursive: true });
  const probeMarker = path.join(runtimeRoot, "probe.txt"), runMarker = path.join(runtimeRoot, "run.txt");
  const quote = (p: string) => p.replaceAll("'", "''");
  await fs.writeFile(path.join(runtimeRoot, "scripts", "ocr-content.ps1"), `param([switch]$Probe,[string]$InputPath,[string]$OutputPath)\nif ($Probe) { [IO.File]::WriteAllText('${quote(probeMarker)}','probe'); exit 0 }; [IO.File]::WriteAllText('${quote(runMarker)}','run'); [IO.File]::WriteAllText($OutputPath, '{"status":"saved","text":"FRESH_OCR"}'); exit 0\n`);
  const id = "image-001", base = id + "-" + crypto.createHash("sha256").update(id).digest("hex").slice(0, 12), md = `derived/ocr/${base}.md`;
  await fs.writeFile(path.join(directory, "source.png"), "new source bytes");
  const r = { ...record("ocr"), kind: "gallery" as const, assets: [{ id, role: "image" as const, status: "saved" as const, path: "source.png", provenance: "original" as const }] };
  return { directory, runtimeRoot, probeMarker, runMarker, r, base, md };
}

test("an untracked nonempty OCR Markdown cannot bypass OCR validation", async t => {
  const f = await ocrFixture(t); await fs.writeFile(path.join(f.directory, f.md), "TRUNCATED_STAGING_TEXT");
  const result = await enrichContent(f.r, { runtimeRoot: f.runtimeRoot, directory: f.directory });
  const ocr = result.assets.find(a => a.role === "ocr"); assert.equal(ocr?.status, "saved");
  assert.match(await fs.readFile(path.join(f.directory, ocr!.path!), "utf8"), /FRESH_OCR/);
  assert.equal(await fs.readFile(f.runMarker, "utf8"), "run");
});

test("a changed source invalidates a previously verified OCR transcript", async t => {
  const f = await ocrFixture(t); await fs.writeFile(path.join(f.directory, f.md), "OLD_SOURCE_OCR");
  const prior = { ...f.r, assets: [{ ...f.r.assets[0], sha256: crypto.createHash("sha256").update("old source bytes").digest("hex") }, { id: `ocr-${f.base}`, role: "ocr" as const, status: "saved" as const, path: f.md, sha256: await fileHash(path.join(f.directory, f.md)), provenance: "machine_ocr" as const }] };
  const result = await enrichContent(f.r, { runtimeRoot: f.runtimeRoot, directory: f.directory, existing: prior });
  const ocr = result.assets.find(a => a.role === "ocr"); assert.equal(ocr?.status, "saved"); assert.match(await fs.readFile(path.join(f.directory, ocr!.path!), "utf8"), /FRESH_OCR/);
});

test("a text-only article does not start the OCR probe", async t => {
  const f = await ocrFixture(t); const r = record("text-only");
  const result = await enrichContent(r, { runtimeRoot: f.runtimeRoot, directory: f.directory }); assert.deepEqual(result.assets, []);
  assert.equal(await fs.stat(f.probeMarker).then(() => true, () => false), false);
});

test("re-submitting a cancelled link queues that same task rather than reporting a phantom enqueue", async t => {
  const root = await fixture(t), [job] = await enqueueInputs(root, [input("requeue")]); await cancelJob(root, job.id);
  const response = await runLinkCli(["enqueue", input("requeue").url], { root, runtimeRoot: root }); assert.equal(response.ok, true);
  const jobs = await getJobs(root); assert.equal(jobs.length, 1); assert.equal(jobs[0].id, job.id); assert.equal(jobs[0].state, "queued"); assert.equal(jobs[0].cancelRequested, false);
});

test("each attempt gets its own execution timestamps instead of using the enqueue date", async t => {
  const { runJobs, retryJob } = await import("../src/content-jobs.js");
  const root = await fixture(t), [job] = await enqueueInputs(root, [input("attempt-time")]);
  let started: string | undefined;
  await runJobs(root, async running => { started = (running as any).startedAt; assert.ok(started); assert.equal((running as any).finishedAt, undefined); return { state: "completed" }; });
  const completed = (await getJobs(root))[0] as any; assert.ok(completed.finishedAt); assert.ok(completed.finishedAt >= started!);
  await retryJob(root, job.id); const retry = (await getJobs(root))[0] as any; assert.equal(retry.startedAt, undefined); assert.equal(retry.finishedAt, undefined);
});

test("a long video description is shown as a bounded heading while full text remains saved", async t => {
  const root = await fixture(t), stage = path.join(root, "stage"); await fs.mkdir(stage);
  const r = { ...record("long-heading"), platform: "wechat_channels" as const, title: "关于软件服务的完整说明".repeat(24), markdown: "关于软件服务的完整说明".repeat(24) + "\n保留完整正文" };
  const m = await saveContent(root, r, stage), $ = cheerio.load(renderContentHtml(m, m.markdown));
  assert.ok(Array.from($("h1").text()).length <= 64); assert.equal(m.title, r.title);
  const saved = await readContent(root, m.contentId); assert.ok(saved.ok); if (saved.ok) assert.match(saved.text, /保留完整正文/);
});

test("a completed duplicate is reported as existing without requesting an empty worker", async t => {
  const { runJobs } = await import("../src/content-jobs.js"); const root = await fixture(t);
  await enqueueInputs(root, [input("complete-existing")]); await runJobs(root, async () => ({ state: "completed" }));
  const response = await runLinkCli(["enqueue", input("complete-existing").url], { root, runtimeRoot: root });
  assert.equal(response.readyCount, 0); assert.equal(response.addedCount, 0); assert.equal(response.existingCount, 1); assert.match(response.message, /已有/);
  assert.equal((await getJobs(root))[0].state, "completed");
});

test("doctor reports an absent configured offline model even when faster-whisper imports", async t => {
  const root = await fixture(t), runtimeRoot = path.join(root, "runtime"); await fs.mkdir(path.join(runtimeRoot, "scripts"), { recursive: true });
  await fs.copyFile(path.join(process.cwd(), "scripts", "transcribe-content.py"), path.join(runtimeRoot, "scripts", "transcribe-content.py"));
  const oldPython = process.env.CONTENT_PYTHON_PATH, oldModel = process.env.CONTENT_ASR_MODEL;
  process.env.CONTENT_PYTHON_PATH = path.join(process.cwd(), ".venv-content", "Scripts", "python.exe"); process.env.CONTENT_ASR_MODEL = path.join(root, "absent-model");
  try { const response = await runLinkCli(["doctor"], { root, runtimeRoot }); assert.equal(response.ok, true); const tools = response.tools as Array<{ id: string; available: boolean; reason?: string }>; const asr = tools.find(a => a.id === "asr")!; assert.equal(asr.available, false); assert.match(asr.reason || "", /模型|model/i); }
  finally { if (oldPython === undefined) delete process.env.CONTENT_PYTHON_PATH; else process.env.CONTENT_PYTHON_PATH = oldPython; if (oldModel === undefined) delete process.env.CONTENT_ASR_MODEL; else process.env.CONTENT_ASR_MODEL = oldModel; }
});

test("jobs control remains usable when the browser dependency is unavailable", async t => {
  const { runContentTool } = await import("../src/content-tools.js"); const root = await fixture(t), loader = path.join(root, "loader.mjs"), register = path.join(root, "register.mjs");
  await fs.writeFile(loader, "export async function resolve(specifier,context,next){if(specifier.includes('playwright-core'))throw new Error('Browser dependency is unavailable in this control fixture');return next(specifier,context);}");
  await fs.writeFile(register, `import {register} from 'node:module';register(${JSON.stringify(pathToFileURL(loader).href)},import.meta.url);`);
  const run = await runContentTool({ command: process.execPath, args: ["--import", "tsx", "--import", pathToFileURL(register).href, path.join(process.cwd(), "src", "link-cli.ts"), "jobs"], cwd: process.cwd(), env: { ...process.env, CONTENT_LIBRARY_ROOT: path.join(root, "library") }, timeoutMs: 15000 });
  assert.equal(run.code, 0, run.stderr); const response = JSON.parse(run.stdout); assert.equal(response.ok, true); assert.deepEqual(response.jobs, []);
});

test("selected tool probes cache results but refresh when the helper changes or force is requested", async t => {
  const { probeContentTools } = await import("../src/content-tools.js"); const root = await fixture(t), scripts = path.join(root, "scripts"), marker = path.join(root, "count.txt"), helper = path.join(scripts, "ocr-content.ps1"); await fs.mkdir(scripts);
  const quoted = marker.replaceAll("'", "''"); const script = `param([switch]$Probe)\n$n=0; if(Test-Path -LiteralPath '${quoted}'){$n=[int]([IO.File]::ReadAllText('${quoted}'))};$n++;[IO.File]::WriteAllText('${quoted}',[string]$n);Write-Output ('available-'+$n)\n`;
  await fs.writeFile(helper, script);
  const first = await probeContentTools(root, { ids: ["ocr"] }); const cached = await probeContentTools(root, { ids: ["ocr"] });
  assert.equal(first.length, 1); assert.equal(first[0].available, true); assert.equal(first[0].version, cached[0].version);
  const forced = await probeContentTools(root, { ids: ["ocr"], force: true }); assert.notEqual(forced[0].version, cached[0].version);
  await fs.writeFile(helper, script + "\n# changed helper\n"); const changed = await probeContentTools(root, { ids: ["ocr"] }); assert.notEqual(changed[0].version, forced[0].version); assert.equal(changed[0].available, true);
});

test("saving a changed source cannot promote the old OCR back to saved after regeneration fails", async t => {
  const root=await fixture(t),stage=path.join(root,"stage");await fs.mkdir(stage);await fs.writeFile(path.join(stage,"source.png"),"old source");await fs.writeFile(path.join(stage,"ocr.md"),"OLD_SOURCE_OCR");
  const source={id:"source",role:"image" as const,status:"saved" as const,path:"source.png",provenance:"original" as const};
  const first={...record("merge-stale"),assets:[source,{id:"ocr-source",role:"ocr" as const,status:"saved" as const,path:"ocr.md",label:"source",provenance:"machine_ocr" as const,derivation:{sourceId:"source",sourceSha256:await fileHash(path.join(stage,"source.png"))}}]};
  await saveContent(root,first,stage);await fs.writeFile(path.join(stage,"source.png"),"new source");
  const latest=await saveContent(root,{...first,assets:[source,{id:"ocr-source",role:"ocr",status:"failed",reason:"regeneration failed",provenance:"machine_ocr"}]},stage);
  assert.equal(latest.assets.find(a=>a.id==="ocr-source")?.status,"failed");assert.doesNotMatch(latest.markdown,/OLD_SOURCE_OCR/);
});

test("a read prioritizes the normal readable ID suffix while still verifying the full manifest identity", async t => {
  const root=await fixture(t),items=path.join(root,"items");await fs.mkdir(items);let target="";
  for(let i=1;i<=24;i++){const id=i.toString(16).padStart(8,"0").padEnd(24,"a"),directory=path.join(items,`sample-${String(i).padStart(3,"0")} [${id.slice(0,8)}]`);await fs.mkdir(directory);await fs.writeFile(path.join(directory,"content.json"),JSON.stringify({...record(String(i)),contentId:id,schemaVersion:1,status:"completed",aliases:[],updatedAt:"2026-10-14T00:00:00Z",contentHash:"fixture",markdownFile:"body.md",readingFile:"reading.html"}));await fs.writeFile(path.join(directory,"body.md"),`body-${i}`);target=id;}
  const spoof=path.join(items,`000-spoof [${target.slice(0,8)}]`);await fs.mkdir(spoof);await fs.writeFile(path.join(spoof,"content.json"),JSON.stringify({...record("spoof"),contentId:"f".repeat(24),schemaVersion:1,warnings:[],assets:[]}));
  const read=fs.readFile.bind(fs);let manifests=0;t.mock.method(fs,"readFile",async(file:any,...args:any[])=>{if(String(file).endsWith("content.json"))manifests++;return (read as any)(file,...args);});
  const result=await readContent(root,target,0,100);assert.ok(result.ok);if(result.ok)assert.equal(result.text,"body-24");assert.ok(manifests<=3,`read parsed ${manifests} manifests for one normal ID`);
});

test("a retry submission refreshes the actual access URL without changing the task identity",async t=>{
  const root=await fixture(t),nativeId="123456789012345678901234",canonicalUrl=`https://www.xiaohongshu.com/explore/${nativeId}`;
  const [job]=await enqueueInputs(root,[{platform:"xiaohongshu",nativeId,canonicalUrl,url:canonicalUrl+"?xsec_token=OLD_PLACEHOLDER"}]);await cancelJob(root,job.id);
  const response=await runLinkCli(["enqueue",canonicalUrl+"?xsec_token=NEW_PLACEHOLDER"],{root,runtimeRoot:root});assert.equal(response.ok,true);
  const [current]=await getJobs(root);assert.equal(current.id,job.id);assert.match(current.input.url,/NEW_PLACEHOLDER/);assert.equal(current.input.nativeId,nativeId);
});

test("MCP accepts an already completed link without trying to launch a worker",async t=>{
  const {runJobs}=await import("../src/content-jobs.js"),{captureLink}=await import("../src/mcp/content-handlers.js"),root=await fixture(t);
  await enqueueInputs(root,[input("mcp-existing")]);await runJobs(root,async()=>({state:"completed"}));
  const oldRoot=process.env.CONTENT_LIBRARY_ROOT,oldRuntime=process.env.WECHAT_ARTICLE_READER_ROOT;process.env.CONTENT_LIBRARY_ROOT=root;process.env.WECHAT_ARTICLE_READER_ROOT=root;
  try{const result=await captureLink({text:input("mcp-existing").url,start:true});assert.equal(result.ok,true);assert.equal(result.workerStarted,false);assert.equal(result.readyCount,0);}
  finally{if(oldRoot===undefined)delete process.env.CONTENT_LIBRARY_ROOT;else process.env.CONTENT_LIBRARY_ROOT=oldRoot;if(oldRuntime===undefined)delete process.env.WECHAT_ARTICLE_READER_ROOT;else process.env.WECHAT_ARTICLE_READER_ROOT=oldRuntime;}
});

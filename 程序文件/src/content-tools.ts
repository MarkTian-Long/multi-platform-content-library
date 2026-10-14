import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ToolAvailability } from "./content-types.js";

export interface ContentToolRunOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

export interface ContentToolRunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

function collectBounded(target: Buffer[], chunk: Buffer, maximum: number): boolean {
  const size = target.reduce((sum, value) => sum + value.length, 0);
  if (size >= maximum) return true;
  target.push(chunk.subarray(0, Math.max(0, maximum - size)));
  return chunk.length > maximum - size;
}

async function killProcessTree(pid: number | undefined): Promise<string | undefined> {
  if (!pid) return "没有可终止的进程标识";
  if (process.platform === "win32") {
    return await new Promise<string | undefined>((resolve) => {
      let stderr = "";
      let stdout = "";
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      killer.stdout?.on("data", (value: Buffer) => { if (stdout.length < 1_024) stdout += value.toString("utf8"); });
      killer.stderr?.on("data", (value: Buffer) => { if (stderr.length < 1_024) stderr += value.toString("utf8"); });
      killer.once("error", (error) => resolve(`taskkill 无法启动：${error.message}`));
      killer.once("close", (code) => {
        if (code === 0) resolve(undefined);
        else resolve(`taskkill 终止进程树失败（退出码 ${code ?? "未知"}）：${(stderr || stdout || "没有诊断输出").replace(/[\r\n]+/g, " ").trim()}`);
      });
    });
  }
  try { process.kill(-pid, "SIGTERM"); return undefined; }
  catch { try { process.kill(pid, "SIGTERM"); return undefined; } catch (error) { return `终止进程失败：${error instanceof Error ? error.message : String(error)}`; } }
}

/** Execute only an explicit executable plus explicit arguments. Output, time and cancellation are bounded. */
export async function runContentTool(options: ContentToolRunOptions): Promise<ContentToolRunResult> {
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10 * 60_000));
  const maxOutputBytes = Math.max(1, Math.min(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 2 * 1024 * 1024));
  if (options.signal?.aborted) return { code: 130, stdout: "", stderr: "operation cancelled", timedOut: false, cancelled: true, outputTruncated: false };
  return await new Promise<ContentToolRunResult>((resolve) => {
    let timedOut = false;
    let cancelled = false;
    let truncated = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let finished = false;
    let stopPromise: Promise<string | undefined> | undefined;
    const settle = (code: number) => {
      if (finished) return;
      void (async () => {
        // A child `close` can race taskkill. Do not report cancellation until the
        // Windows tree traversal itself has completed and supplied any diagnostic.
        const diagnostic = stopPromise ? await stopPromise : undefined;
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (diagnostic) stderr.push(Buffer.from(`${diagnostic}\n`));
        resolve({ code: timedOut || cancelled ? 130 : code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), timedOut, cancelled, outputTruncated: truncated });
      })();
    };
    let child;
    try {
      child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (error) {
      resolve({ code: 127, stdout: "", stderr: error instanceof Error ? error.message : "unable to start tool", timedOut: false, cancelled: false, outputTruncated: false });
      return;
    }
    const stop = (reason: "timeout" | "cancel") => {
      if (finished) return;
      timedOut ||= reason === "timeout";
      cancelled ||= reason === "cancel";
      if (stopPromise) return;
      // On Windows, taskkill must see the parent alive to traverse and end its owned descendant tree.
      // `close` waits for this promise, so a failed taskkill is included in the result diagnostic.
      stopPromise = killProcessTree(child.pid).then((diagnostic) => {
        // taskkill has completed its `/T` traversal; this only handles a direct child that raced it.
        if (child.exitCode === null) try { child.kill(); } catch { /* process may already have exited */ }
        return diagnostic;
      });
    };
    const abort = () => stop("cancel");
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (value: Buffer) => { truncated ||= collectBounded(stdout, Buffer.from(value), maxOutputBytes); });
    child.stderr?.on("data", (value: Buffer) => { truncated ||= collectBounded(stderr, Buffer.from(value), maxOutputBytes); });
    child.once("error", (error) => { stderr.push(Buffer.from(error.message)); settle(127); });
    child.once("close", (code) => settle(code ?? 1));
  });
}

async function usableFile(candidate: string): Promise<string | undefined> {
  try { return (await fs.stat(candidate)).isFile() ? candidate : undefined; } catch { return undefined; }
}

async function firstLocal(runtimeRoot: string, names: string[], configured?: string): Promise<string | undefined> {
  for (const candidate of [configured, ...names.flatMap((name) => [path.join(runtimeRoot, "tools", name), path.join(runtimeRoot, "tools", `${name}.exe`)])]) {
    if (candidate && await usableFile(candidate)) return candidate;
  }
  return undefined;
}

async function probeExecutable(id: string, name: string, runtimeRoot: string, envKey?: string,signal?:AbortSignal): Promise<ToolAvailability> {
  const local = await firstLocal(runtimeRoot, [name], envKey ? process.env[envKey] : undefined);
  const command = local ?? name;
  const result = await runContentTool({ command, args: name === "ffmpeg" || name === "ffprobe" ? ["-version"] : ["--version"], timeoutMs: 5_000, maxOutputBytes: 4_096,signal });
  if (result.code === 0) return { id, name, available: true, path: command, version: result.stdout.trim().split(/\r?\n/)[0]?.slice(0, 240) };
  return { id, name, available: false, reason: local ? `${name} cannot run: ${result.stderr.trim() || `exit ${result.code}`}` : `${name} was not found in ${path.join(runtimeRoot, "tools")} or PATH` };
}

export type ContentToolId="yt-dlp"|"ffmpeg"|"ffprobe"|"asr"|"ocr";
export interface ContentProbeOptions {ids?:ContentToolId[];force?:boolean;signal?:AbortSignal;}
const probeCache=new Map<string,{expires:number;tools:ToolAvailability[]}>();
/** Discover selected local tools; changed files/configuration invalidate the short worker cache. */
export async function probeContentTools(runtimeRoot:string,options:ContentProbeOptions={}):Promise<ToolAvailability[]>{
  if(options.signal?.aborted)throw new DOMException("已取消","AbortError");
  const ids=[...new Set(options.ids??["yt-dlp","ffmpeg","ffprobe","asr","ocr"])] as ContentToolId[];
  if(!ids.length)return [];
  const model=process.env.CONTENT_ASR_MODEL||path.join(runtimeRoot,"tools","models","faster-whisper-tiny");
  const modelFiles=["model.bin","config.json","tokenizer.json"].map(file=>path.join(model,file));
  const configured=[process.env.CONTENT_YTDLP_PATH,process.env.CONTENT_FFMPEG_PATH,process.env.CONTENT_FFPROBE_PATH,process.env.CONTENT_PYTHON_PATH,process.env.CONTENT_OCR_PATH];
  const watched=[...configured,...ids.flatMap(id=>[path.join(runtimeRoot,"tools",id),path.join(runtimeRoot,"tools",id+".exe")]),path.join(runtimeRoot,"scripts","ocr-content.ps1"),path.join(runtimeRoot,"scripts","transcribe-content.py"),path.join(runtimeRoot,".venv-content","Scripts","python.exe"),...(ids.includes("asr")?modelFiles:[])].filter((file):file is string=>!!file);
  const stamps=await Promise.all(watched.map(async file=>{const s=await fs.stat(file).catch(()=>undefined);return s?`${file}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`:`${file}:missing`;}));
  const key=JSON.stringify([path.resolve(runtimeRoot),ids,configured,process.env.PATH,ids.includes("asr")?model:undefined,stamps]);
  const cached=probeCache.get(key);if(!options.force&&cached&&cached.expires>Date.now())return cached.tools.map(tool=>({...tool}));
  const tools:ToolAvailability[]=await Promise.all(ids.filter(id=>["yt-dlp","ffmpeg","ffprobe"].includes(id)).map(id=>probeExecutable(id,id,runtimeRoot,{"yt-dlp":"CONTENT_YTDLP_PATH",ffmpeg:"CONTENT_FFMPEG_PATH",ffprobe:"CONTENT_FFPROBE_PATH"}[id as "yt-dlp"|"ffmpeg"|"ffprobe"],options.signal)));
  if(ids.includes("asr")){
    const bundledPython=path.join(runtimeRoot,".venv-content","Scripts","python.exe"),python=process.env.CONTENT_PYTHON_PATH||await usableFile(bundledPython)||"python";
    const filesReady=(await Promise.all(modelFiles.map(file=>fs.stat(file).then(s=>s.isFile()&&s.size>0,()=>false)))).every(Boolean);
    if(!filesReady)tools.push({id:"asr",name:"faster-whisper",available:false,reason:"缺少离线 ASR 模型文件：请检查 CONTENT_ASR_MODEL 或安装模型（model.bin、config.json、tokenizer.json）"});
    else{const asr=await runContentTool({command:python,args:[path.join(runtimeRoot,"scripts","transcribe-content.py"),"--probe","--model",model],timeoutMs:8000,maxOutputBytes:4096,signal:options.signal});tools.push({id:"asr",name:"faster-whisper",available:asr.code===0,path:asr.code===0?python:undefined,version:asr.code===0?asr.stdout.trim().slice(0,240):undefined,reason:asr.code===0?undefined:asr.stderr.trim()||"faster-whisper Python runtime is unavailable"});}
  }
  if(ids.includes("ocr")){
    const command=process.env.CONTENT_OCR_PATH||"powershell.exe",ocr=await runContentTool({command,args:["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",path.join(runtimeRoot,"scripts","ocr-content.ps1"),"-Probe"],timeoutMs:8000,maxOutputBytes:4096,signal:options.signal});tools.push({id:"ocr",name:"Windows.Media.Ocr",available:ocr.code===0,path:ocr.code===0?command:undefined,version:ocr.code===0?ocr.stdout.trim().slice(0,240):undefined,reason:ocr.code===0?undefined:ocr.stderr.trim()||"Windows.Media.Ocr language data is unavailable"});
  }
  if(options.signal?.aborted)throw new DOMException("已取消","AbortError");
  if(probeCache.size>=100)probeCache.clear();probeCache.set(key,{expires:Date.now()+30000,tools});return tools.map(tool=>({...tool}));
}

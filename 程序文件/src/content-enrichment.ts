import fs from "node:fs/promises";
import path from "node:path";
import { createHash,randomUUID } from "node:crypto";
import type { CapturedContent, ContentAsset, ContentContext } from "./content-types.js";
import { probeContentTools, runContentTool, type ContentToolRunResult } from "./content-tools.js";
import { atomicReplace,containedFile,fileHash,writableFile } from "./content-library.js";
import { completeDerivedFiles,trustedDerivedFiles,processingFingerprint } from "./content-derivation.js";
import { readAsrBundle,type AsrBundle,type AsrPaths } from "./content-asr-bundle.js";

type TimedText = { startMs: number; endMs: number; text: string };
const OUTPUT_ROOT = "derived";
const NO_AUDIO_STREAM_REASON = "原视频没有音轨，无法生成音频/语音文字稿";

function safeId(value: string): string {
  const readable = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 56) || "asset";
  return `${readable}-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}
function timestamp(milliseconds: number): string {
  const ms = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(ms / 3_600_000); const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000); const remainder = ms % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(remainder).padStart(3, "0")}`;
}

function parseTime(value: string): number | undefined {
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})$/.exec(value.trim());
  if (!match) return undefined;
  return ((Number(match[1] ?? 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1_000 + Number(match[4]);
}

/** Parse WebVTT/SRT blocks only when each cue has both a valid time range and visible text. */
export function parseTimedSubtitle(source: string): TimedText[] {
  const lines = source.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
  const result: TimedText[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*(WEBVTT|\d+)\s*$/.test(lines[index])) continue;
    const range = /^\s*(\d{2}:\d{2}[.,]\d{3}|\d+:\d{2}:\d{2}[.,]\d{3})\s+-->\s+(\d{2}:\d{2}[.,]\d{3}|\d+:\d{2}:\d{2}[.,]\d{3})/.exec(lines[index]);
    if (!range) continue;
    const startMs = parseTime(range[1]); const endMs = parseTime(range[2]);
    const text: string[] = [];
    while (++index < lines.length && lines[index].trim()) text.push(lines[index].replace(/<[^>]+>/g, "").trim());
    const visible = text.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (startMs !== undefined && endMs !== undefined && endMs > startMs && visible) result.push({ startMs, endMs, text: visible });
  }
  return result;
}

function hasCoverage(cues: TimedText[], durationSeconds: number | undefined): boolean {
  if (!cues.length) return false;
  if (!durationSeconds || durationSeconds <= 0) return true;
  const end = Math.max(...cues.map((cue) => cue.endMs));
  const start = Math.min(...cues.map((cue) => cue.startMs));
  return start <= 5_000 && end >= durationSeconds * 1_000 - 5_000;
}

function resultReason(result: ContentToolRunResult): string {
  if (result.cancelled) return "处理已取消";
  if (result.timedOut) return "处理超时";
  const message = (result.stderr || result.stdout || `工具退出码 ${result.code}`).replace(/[\r\n]+/g, " ").trim();
  return message.length > 300 ? message.slice(-300) : message;
}

function relativePath(directory: string, assetPath: string): string | undefined {
  if (!assetPath || path.isAbsolute(assetPath)) return undefined;
  const normal = path.normalize(assetPath);
  if (normal === ".." || normal.startsWith(`..${path.sep}`)) return undefined;
  const absolute = path.resolve(directory, normal);
  const relative = path.relative(path.resolve(directory), absolute);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? normal.replace(/\\/g, "/") : undefined;
}

async function presentFile(directory: string, candidate: string | undefined): Promise<boolean> {
  if (!candidate) return false;
  const relative = relativePath(directory, candidate);
  if (!relative) return false;
  try {
    const realRoot = await fs.realpath(directory);
    const realFile = await fs.realpath(path.join(directory, relative));
    const contained = path.relative(realRoot, realFile);
    const stat = await fs.stat(realFile);
    return !contained.startsWith("..") && !path.isAbsolute(contained) && stat.isFile() && stat.size > 0;
  } catch { return false; }
}

function cloneContent(record: CapturedContent): CapturedContent {
  return { ...record, assets: record.assets.map((asset) => ({ ...asset })), warnings: [...record.warnings], coverage: { ...record.coverage }, parts: record.parts?.map((part) => ({ ...part })) };
}

async function checkpoint(context: ContentContext, record: CapturedContent): Promise<void> {
  await context.onCheckpoint?.(record);
}

function findAsset(record: CapturedContent, id: string): ContentAsset | undefined { return record.assets.find((asset) => asset.id === id); }
async function saveStatus(context: ContentContext, record: CapturedContent, asset: ContentAsset): Promise<void> {
  if(asset.status==="saved"&&asset.path){const file=await containedFile(context.directory,asset.path);asset={...asset,bytes:(await fs.stat(file)).size,sha256:await fileHash(file),integrityFailed:false,reason:asset.reason};}
  const existing = findAsset(record, asset.id);
  if (existing) Object.assign(existing, asset); else record.assets.push(asset);
  await checkpoint(context, record);
}

function partFor(asset: ContentAsset): string { return asset.partId || "whole"; }
function missing(id: string, role: ContentAsset["role"], reason: string, source: ContentAsset, provenance: ContentAsset["provenance"] = "generated"): ContentAsset {
  return { id, role, status: "missing_dependency", provenance, reason, partId: source.partId, startMs: source.startMs, endMs: source.endMs, label: source.id };
}

async function writeText(directory: string, relative: string, value: string): Promise<void> {
  if (!relativePath(directory, relative)) throw new Error("派生产物路径超出内容目录");
  const destination=await writableFile(directory,relative),temporary=`${destination}.${randomUUID()}.tmp`;
  try{await fs.writeFile(temporary,value,"utf8");await atomicReplace(temporary,destination);}finally{await fs.unlink(temporary).catch(()=>{});}
}

async function derivedDirectory(directory: string, relative: string): Promise<string> {
  if (!relativePath(directory, relative)) throw new Error("派生产物路径超出内容目录");
  return path.dirname(await writableFile(directory,`${relative}/.directory-check`));
}

async function clearPlaceholder(context: ContentContext, record: CapturedContent, id: string): Promise<void> {
  const index = record.assets.findIndex((asset) => asset.id === id && asset.status !== "saved");
  if (index >= 0) { record.assets.splice(index, 1); await checkpoint(context, record); }
}

async function subtitleTranscript(record: CapturedContent, context: ContentContext, subtitle: ContentAsset, cues: TimedText[]): Promise<void> {
  const id = `transcript-platform-${safeId(subtitle.id)}`;
  const output = `${OUTPUT_ROOT}/transcripts/${safeId(subtitle.id)}.md`;
  const text=["# 平台字幕文字稿", "", ...cues.map((cue) => `- [${timestamp(cue.startMs)} – ${timestamp(cue.endMs)}] ${cue.text}`), ""].join("\n");
  if(await fs.readFile(path.join(context.directory,output),"utf8").catch(()=>undefined)!==text)await writeText(context.directory,output,text);
  const derivation={sourceId:subtitle.id,sourceSha256:await fileHash(await containedFile(context.directory,subtitle.path!)),processingFingerprint:processingFingerprint({processor:"platform-subtitle-v1"})};
  await saveStatus(context, record, { id, role: "transcript", status: "saved", path: output, provenance: "platform_subtitle", language: subtitle.language, partId: subtitle.partId, label: `由平台字幕 ${subtitle.id} 生成`,derivation });
}

/** `false` is reserved for an ffprobe-confirmed absence of audio streams. */
async function hasAudioStream(context: ContentContext, input: string, ffprobe: string | undefined): Promise<boolean | undefined> {
  if (!ffprobe) return undefined;
  const probe = await runContentTool({ command: ffprobe, args: ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", input], signal: context.signal, timeoutMs: 15_000, maxOutputBytes: 4_096 });
  if (probe.code !== 0) return undefined;
  try {
    const data = JSON.parse(probe.stdout) as { streams?: Array<{ codec_type?: string }> };
    return Array.isArray(data.streams) ? data.streams.some((stream) => stream.codec_type === "audio") : undefined;
  } catch { return undefined; }
}

async function extractMedia(record: CapturedContent, context: ContentContext, source: ContentAsset, tools: Map<string, string | undefined>): Promise<ContentAsset[]> {
  const result: ContentAsset[] = [];
  if (!source.path || !await presentFile(context.directory, source.path)) return result;
  const input = path.join(context.directory, source.path);
  const base = safeId(source.id); const audio = `${OUTPUT_ROOT}/audio/${base}.m4a`;
  const sourceHash=await fileHash(await containedFile(context.directory,source.path));
  const audioFile={id:`audio-${base}`,path:audio},audioReceipt=`${OUTPUT_ROOT}/proofs/${base}.audio.json`;
  const existingAudio = await trustedDerivedFiles(context,source,[audioFile],audioReceipt);
  const ffmpeg = tools.get("ffmpeg");
  if (!ffmpeg) {
    const reason = "缺少 ffmpeg：无法从已保存视频提取音轨和关键画面";
    if (!existingAudio) await saveStatus(context, record, missing(`audio-${base}`, "audio", reason, source));
    if (context.processing !== "transcribe" && !record.assets.some((asset) => asset.id.startsWith(`frame-${base}-`) && asset.status === "saved" && asset.path)) await saveStatus(context, record, missing(`frames-${base}`, "frame", reason, source, "sampled_frame"));
    return result;
  }
  let audioSucceeded = existingAudio;
  const noAudioStream = !audioSucceeded && await hasAudioStream(context, input, tools.get("ffprobe")) === false;
  if (noAudioStream) {
    await clearPlaceholder(context, record, `audio-${base}`);
    await saveStatus(context, record, { id: `audio-${base}`, role: "audio", status: "unavailable", provenance: "generated", reason: NO_AUDIO_STREAM_REASON, partId: source.partId, label: source.id });
    record.coverage = { ...record.coverage, [`audio:${source.id}`]: "原视频没有音轨" };
    await checkpoint(context, record);
  } else if (!audioSucceeded) {
    const audioDirectory = await derivedDirectory(context.directory, `${OUTPUT_ROOT}/audio`);
    const temporaryAudio = path.join(audioDirectory, `${base}.partial.m4a`);
    await fs.rm(temporaryAudio, { force: true }).catch(() => {});
    const run = await runContentTool({ command: ffmpeg, args: ["-nostdin", "-i", input, "-map", "0:a:0?", "-vn", "-c:a", "aac", "-f", "mp4", temporaryAudio], signal: context.signal, timeoutMs: 120_000 });
    audioSucceeded = run.code === 0 && await presentFile(context.directory, `${OUTPUT_ROOT}/audio/${base}.partial.m4a`);
    if (audioSucceeded) await fs.rename(temporaryAudio, path.join(context.directory, audio));
    if (!audioSucceeded) await saveStatus(context, record, { id: `audio-${base}`, role: "audio", status: run.cancelled ? "skipped" : "failed", provenance: "generated", reason: resultReason(run), partId: source.partId, label: source.id });
  }
  if (audioSucceeded) {
    await clearPlaceholder(context, record, `audio-${base}`);
    const fingerprint=existingAudio?findAsset(context.existing??record,audioFile.id)?.derivation?.processingFingerprint||processingFingerprint({processor:"verified-existing-audio"}):processingFingerprint({processor:"ffmpeg",operation:"extract-aac"});
    const derivation=await completeDerivedFiles(context,source,[audioFile],audioReceipt,fingerprint,sourceHash);
    const asset: ContentAsset = { id: `audio-${base}`, role: "audio", status: "saved", path: audio, provenance: "generated", partId: source.partId, label: `由 ${source.id} 提取的音轨`,derivation };
    await saveStatus(context, record, asset); result.push(asset);
  }
  if (context.processing === "transcribe") return result;
  const duration = await mediaDuration(context, input, tools.get("ffprobe"));
  const intervalSeconds = duration ? Math.max(1, Math.ceil(duration / 24)) : 15;
  const frameDir = `${OUTPUT_ROOT}/frames/${base}`;
  const absoluteFrameDir = path.join(context.directory, frameDir);
  await derivedDirectory(context.directory,`${OUTPUT_ROOT}/frames`);
  if (await fs.lstat(absoluteFrameDir).then((stat) => stat.isSymbolicLink()).catch(() => false)) {
    await saveStatus(context, record, { id: `frames-${base}`, role: "frame", status: "failed", provenance: "sampled_frame", reason: "关键帧目录不能是内容目录外的链接", partId: source.partId, label: source.id });
    return result;
  }
  const existing = (await fs.readdir(absoluteFrameDir).catch(() => [])).filter(file=>/^frame-\d+\.jpg$/.test(file)).sort();
  const existingFiles=existing.map((file,i)=>({id:`frame-${base}-${i+1}`,path:`${frameDir}/${file}`})),frameReceipt=`${OUTPUT_ROOT}/proofs/${base}.frames.json`;
  const priorFrames=context.existing?.assets.filter(a=>a.id.startsWith(`frame-${base}-`))??[];
  const reusedFrames=existing.length>0&&(!priorFrames.length||priorFrames.length===existing.length)&&await trustedDerivedFiles(context,source,existingFiles,frameReceipt);
  let framesSucceeded = reusedFrames;
  let frameTimes: number[] = [];
  if (!framesSucceeded) {
    const stageRelative = `${OUTPUT_ROOT}/frames/.partial-${base}`;
    const stageDirectory = path.join(context.directory, stageRelative);
    await derivedDirectory(context.directory,stageRelative);
    await fs.rm(stageDirectory, { recursive: true, force: true }).catch(() => {});
    await derivedDirectory(context.directory, stageRelative);
    const run = await runContentTool({ command: ffmpeg, args: ["-nostdin", "-i", input, "-vf", `fps=1/${intervalSeconds},showinfo`, "-frames:v", "24", path.join(stageDirectory, "frame-%03d.jpg")], signal: context.signal, timeoutMs: 120_000 });
    frameTimes = [...run.stderr.matchAll(/pts_time:([\d.-]+)/g)].map((match) => Number(match[1]) * 1_000).filter((value) => Number.isFinite(value) && value >= 0);
    const stagedFrames = (await fs.readdir(stageDirectory).catch(() => [])).filter((file) => /^frame-\d+\.jpg$/.test(file));
    framesSucceeded = run.code === 0 && stagedFrames.length > 0;
    if (framesSucceeded) {
      context.signal?.throwIfAborted();if(await fileHash(await containedFile(context.directory,source.path))!==sourceHash)throw new Error("抽帧期间原始素材已变化");
      let previous:string|undefined;
      if(await fs.lstat(absoluteFrameDir).then(()=>true,()=>false)){previous=`${absoluteFrameDir}.superseded-${randomUUID()}`;await fs.rename(absoluteFrameDir,previous);}
      try{await fs.rename(stageDirectory,absoluteFrameDir);}catch(error){if(previous)await fs.rename(previous,absoluteFrameDir).catch(()=>{});throw error;}
    }
    if (!framesSucceeded) await saveStatus(context, record, { id: `frames-${base}`, role: "frame", status: run.cancelled ? "skipped" : "failed", provenance: "sampled_frame", reason: resultReason(run), partId: source.partId, label: source.id });
  }
  const frames = framesSucceeded ? (await fs.readdir(absoluteFrameDir).catch(() => [])).filter((file) => /^frame-\d+\.jpg$/.test(file)).sort() : [];
  if (frames.length) {
    await clearPlaceholder(context, record, `frames-${base}`);
    const frameFiles=frames.map((file,i)=>({id:`frame-${base}-${i+1}`,path:`${frameDir}/${file}`}));
    const derivation=await completeDerivedFiles(context,source,frameFiles,frameReceipt,processingFingerprint({processor:reusedFrames?"verified-existing-frames":"ffmpeg-frames",intervalSeconds}),sourceHash);
    record.coverage = { ...record.coverage, [`frames:${source.id}`]: `每 ${intervalSeconds} 秒抽样，最多 24 帧；已保存 ${frames.length} 帧${duration ? `，媒体时长约 ${Math.round(duration)} 秒` : "（未取得总时长）"}` };
    for (const [index, file] of frames.entries()) {
      const prior=reusedFrames?priorFrames.find(a=>a.id===`frame-${base}-${index+1}`):undefined;
      const startMs = Math.round(prior?.startMs??frameTimes[index] ?? index * intervalSeconds * 1_000);
      const endMs=Math.min(duration?Math.round(duration*1000):Number.MAX_SAFE_INTEGER,prior?.endMs??startMs+Math.round(intervalSeconds*1000));
      const frame: ContentAsset = { id: `frame-${base}-${index + 1}`, role: "frame", status: "saved", path: `${frameDir}/${file}`, provenance: "sampled_frame", partId: source.partId, startMs, endMs, label: source.id,derivation };
      await saveStatus(context, record, frame); result.push(frame);
    }
  }
  return result;
}

async function mediaDuration(context: ContentContext, input: string, ffprobe: string | undefined): Promise<number | undefined> {
  if (!ffprobe) return undefined;
  const probe = await runContentTool({ command: ffprobe, args: ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", input], signal: context.signal, timeoutMs: 15_000, maxOutputBytes: 1_024 });
  const value = Number(probe.stdout.trim()); return probe.code === 0 && Number.isFinite(value) && value > 0 ? value : undefined;
}

async function saveAsrBundle(record:CapturedContent,context:ContentContext,source:ContentAsset,paths:AsrPaths,bundle:AsrBundle,sourceHash:string):Promise<void>{
  const base=safeId(source.id),files=[{id:`transcript-asr-${base}`,path:paths.md},{id:`asr-data-${base}`,path:paths.json},{id:`asr-subtitle-${base}`,path:paths.srt}];
  const derivation=await completeDerivedFiles(context,source,files,`${OUTPUT_ROOT}/proofs/${base}.asr.json`,bundle.fingerprint,sourceHash);
  record.warnings=record.warnings.filter(w=>!w.startsWith("本轮 ASR 未完成："));
  const segments=bundle.data.segments as TimedText[];
  record.coverage={...record.coverage,[`asr:${source.id}`]:`已核验本地 machine_asr 三件套，模型 ${bundle.model||"已有记录"}；${segments.length} 段，语言 ${bundle.language||"未知"}`};
  for(const [i,file] of files.entries())await saveStatus(context,record,{...file,role:(["transcript","source","subtitle"] as const)[i],status:"saved",provenance:"machine_asr",language:bundle.language,partId:source.partId,label:source.id,startMs:segments[0].startMs,endMs:segments.at(-1)!.endMs,derivation});
}
async function machineAsr(record: CapturedContent, context: ContentContext, source: ContentAsset): Promise<void> {
  if (!source.path || !await presentFile(context.directory, source.path)) return;
  const base=safeId(source.id),paths:AsrPaths={md:`${OUTPUT_ROOT}/transcripts/${base}.asr.md`,json:`${OUTPUT_ROOT}/transcripts/${base}.asr.json`,srt:`${OUTPUT_ROOT}/transcripts/${base}.asr.srt`};
  const files=[{id:`transcript-asr-${base}`,path:paths.md},{id:`asr-data-${base}`,path:paths.json},{id:`asr-subtitle-${base}`,path:paths.srt}],receipt=`${OUTPUT_ROOT}/proofs/${base}.asr.json`;
  const sourceHash=await fileHash(await containedFile(context.directory,source.path));
  const cached=await readAsrBundle(context,paths,parseTimedSubtitle),trusted=!!cached&&await trustedDerivedFiles(context,source,files,receipt);
  const requestedModel=process.env.CONTENT_ASR_MODEL?.trim();
  // Historical outputs record only the model basename, which cannot prove override weights.
  // An explicit model therefore requests processing; an unset model preserves verified results.
  if(cached&&trusted&&!requestedModel){context.onProgress?.("复用已核验的语音文字稿");await saveAsrBundle(record,context,source,paths,cached,sourceHash);return;}
  if(!cached||!trusted)for(const file of files){const asset=findAsset(record,file.id);if(asset){asset.status="failed";asset.integrityFailed=true;asset.reason="ASR 来源、完成记录或三件套内容校验未通过";}}
  const model=requestedModel||path.join(context.runtimeRoot,"tools","models","faster-whisper-tiny"),bundledPython=path.join(context.runtimeRoot,".venv-content","Scripts","python.exe");
  const python=process.env.CONTENT_PYTHON_PATH||(await fs.stat(bundledPython).then(s=>s.isFile()).catch(()=>false)?bundledPython:"python"),helper=path.join(context.runtimeRoot,"scripts","transcribe-content.py");
  if(!await fs.stat(helper).then(s=>s.isFile()).catch(()=>false)){
    await saveStatus(context,record,{id:files[0].id,role:"transcript",status:"missing_dependency",provenance:"machine_asr",reason:"缺少本地 ASR helper 或 faster-whisper 运行时",partId:source.partId,label:source.id});return;
  }
  const suffix=`.${randomUUID()}.pending`,pending:AsrPaths={md:paths.md+suffix,json:paths.json+suffix,srt:paths.srt+suffix};
  const absolute={md:await writableFile(context.directory,pending.md),json:await writableFile(context.directory,pending.json),srt:await writableFile(context.directory,pending.srt)};
  try{
    context.onProgress?.("正在本地 ASR 识别（总进度未知）");
    const run=await runContentTool({command:python,args:[helper,"--input",path.join(context.directory,source.path),"--output-json",absolute.json,"--output-srt",absolute.srt,"--output-md",absolute.md,"--model",model],signal:context.signal,timeoutMs:10*60000});
    const bundle=run.code===0?await readAsrBundle(context,pending,parseTimedSubtitle):undefined;
    if(bundle){
      context.signal?.throwIfAborted();if(await fileHash(await containedFile(context.directory,source.path))!==sourceHash)throw new Error("ASR 期间原始素材已变化");
      for(const key of ["json","srt","md"] as const)await atomicReplace(absolute[key],await writableFile(context.directory,paths[key]));
      await saveAsrBundle(record,context,source,paths,bundle,sourceHash);return;
    }
    const reason=run.code===0?"ASR JSON、SRT、Markdown 内容或时间轴不完整/不一致":run.code===3?"缺少离线 faster-whisper 模型：设置 CONTENT_ASR_MODEL 为已验证的本地模型目录":resultReason(run);
    record.warnings.push(`本轮 ASR 未完成：${reason}`);
    await saveStatus(context,record,{id:files[0].id,role:"transcript",status:run.cancelled?"skipped":run.code===2||run.code===3?"missing_dependency":"failed",provenance:"machine_asr",reason,partId:source.partId,label:source.id});
  }finally{for(const file of Object.values(absolute))await fs.unlink(file).catch(()=>{});}
}

async function ocrAsset(record: CapturedContent, context: ContentContext, source: ContentAsset, ocrAvailable: boolean): Promise<void> {
  if (!source.path || !await presentFile(context.directory, source.path)) return;
  const base = safeId(source.id); const output = `${OUTPUT_ROOT}/ocr/${base}.json`; const markdown = `${OUTPUT_ROOT}/ocr/${base}.md`;
  const id=`ocr-${base}`,dataId=`ocr-data-${base}`,receipt=`${OUTPUT_ROOT}/proofs/${base}.ocr.json`,sourceHash=await fileHash(await containedFile(context.directory,source.path));
  const mdFile={id,path:markdown},dataFile={id:dataId,path:output};
  const cachedFiles=await trustedDerivedFiles(context,source,[mdFile,dataFile],receipt)?[mdFile,dataFile]:await trustedDerivedFiles(context,source,[mdFile],receipt)?[mdFile]:undefined;
  if(cachedFiles){
    const text=await fs.readFile(await containedFile(context.directory,markdown),"utf8");
    if(text.split(/\r?\n/).some(line=>line.trim()&&!/^(?:#|来源：|时间点：)/.test(line))){
      const files=cachedFiles;
      const fingerprint=findAsset(context.existing??record,id)?.derivation?.processingFingerprint||processingFingerprint({processor:"Windows.Media.Ocr",legacyVerified:true});
      const derivation=await completeDerivedFiles(context,source,files,receipt,fingerprint,sourceHash);
      for(const file of files)await saveStatus(context,record,{...file,role:file.id===id?"ocr":"source",status:"saved",provenance:"machine_ocr",partId:source.partId,startMs:source.startMs,endMs:source.endMs,label:source.id,derivation});return;
    }
  }
  for(const assetId of [id,dataId]){const prior=findAsset(record,assetId);if(prior){prior.status="failed";prior.integrityFailed=true;prior.reason="OCR 来源或完成记录校验未通过";}}
  if (!ocrAvailable) { await saveStatus(context, record, missing(`ocr-${base}`, "ocr", "缺少 Windows.Media.Ocr：请安装可用的 Windows OCR 语言功能", source, "machine_ocr")); return; }
  const pending=output+`.${randomUUID()}.pending`,pendingFile=await writableFile(context.directory,pending);
  try{
  const run = await runContentTool({ command: process.env.CONTENT_OCR_PATH || "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(context.runtimeRoot, "scripts", "ocr-content.ps1"), "-InputPath", path.join(context.directory, source.path), "-OutputPath", pendingFile], signal: context.signal, timeoutMs: 90_000 });
  if (run.code !== 0 || !await presentFile(context.directory, pending)) { await saveStatus(context, record, { id: `ocr-${base}`, role: "ocr", status: run.cancelled ? "skipped" : "failed", provenance: "machine_ocr", reason: resultReason(run), partId: source.partId, startMs: source.startMs, endMs: source.endMs, label: source.id }); return; }
  let data: { status?: string; text?: string };
  try { if((await fs.stat(pendingFile)).size>8*1024*1024)throw new Error("OCR 文件超过上限");data = JSON.parse(await fs.readFile(pendingFile, "utf8")); } catch { await saveStatus(context, record, { id: `ocr-${base}`, role: "ocr", status: "failed", provenance: "machine_ocr", reason: "OCR 输出不是有效 JSON 或超过上限", partId: source.partId, startMs: source.startMs, endMs: source.endMs, label: source.id }); return; }
  if (data.status !== "saved" && data.status !== "blank" || typeof data.text !== "string") { await saveStatus(context, record, { id: `ocr-${base}`, role: "ocr", status: "failed", provenance: "machine_ocr", reason: "OCR 输出缺少可验证状态或文字字段", partId: source.partId, startMs: source.startMs, endMs: source.endMs, label: source.id }); return; }
  context.signal?.throwIfAborted();if(await fileHash(await containedFile(context.directory,source.path))!==sourceHash)throw new Error("OCR 期间原始素材已变化");
  await atomicReplace(pendingFile,await writableFile(context.directory,output));
  const text = data.text?.trim() || "";
  await writeText(context.directory, markdown, ["# 图片文字识别", "", `来源：${source.id}`, source.startMs !== undefined ? `时间点：${timestamp(source.startMs)}` : "", "", text || "（已识别，未检测到可读文字。）", ""].filter(Boolean).join("\n"));
  const fingerprint=processingFingerprint({processor:"Windows.Media.Ocr",helperSha256:await fileHash(path.join(context.runtimeRoot,"scripts","ocr-content.ps1"))}),derivation=await completeDerivedFiles(context,source,[mdFile,dataFile],receipt,fingerprint,sourceHash);
  await saveStatus(context, record, { id: `ocr-${base}`, role: "ocr", status: "saved", path: markdown, provenance: "machine_ocr", reason: text ? undefined : "已识别，未检测到可读文字", partId: source.partId, startMs: source.startMs, endMs: source.endMs, label: source.id,derivation });
  await saveStatus(context,record,{id:dataId,role:"source",status:"saved",path:output,provenance:"machine_ocr",partId:source.partId,label:source.id,derivation});
  }finally{await fs.unlink(pendingFile).catch(()=>{});}
}

/** Add offline, local-only text evidence. Original files stay untouched and every output is under context.directory/derived. */
export async function enrichContent(record: CapturedContent, context: ContentContext): Promise<CapturedContent> {
  const output = cloneContent(record);
  output.processingMode = context.processing ?? record.processingMode ?? "full";
  if (context.signal?.aborted) { output.warnings.push("媒体处理已取消；已保存的原始资料保持不变"); await checkpoint(context, output); return output; }
  const invalid = output.assets.filter((asset) => asset.path && !relativePath(context.directory, asset.path));
  for (const asset of invalid) { asset.status = "failed"; asset.reason = "资料路径必须位于内容目录内"; await checkpoint(context, output); }
  if (output.processingMode === "original") { await checkpoint(context, output); return output; }
  context = { ...context, processing: output.processingMode };
  const originals = output.assets.filter((asset) => asset.status === "saved" && asset.path && !invalid.includes(asset));
  const hasVideo=originals.some(a=>a.role==="video"),hasImages=originals.some(a=>a.role==="image");
  const availability=await probeContentTools(context.runtimeRoot,{ids:hasVideo?(context.processing==="transcribe"?["ffmpeg","ffprobe"]:["ffmpeg","ffprobe","ocr"]):hasImages?["ocr"]:[],signal:context.signal});
  const tools = new Map(availability.map((tool) => [tool.id, tool.available ? tool.path : undefined]));
  const subtitles = originals.filter((asset) => asset.role === "subtitle"&&asset.provenance!=="machine_asr");
  const goodSubtitles = new Map<string, TimedText[]>();
  for (const subtitle of subtitles) {
    try {
      if (!await presentFile(context.directory, subtitle.path)) throw new Error("字幕不在内容目录内或不是有效文件");
      const cues = parseTimedSubtitle(await fs.readFile(path.join(context.directory, subtitle.path!), "utf8"));
      if (cues.length) { goodSubtitles.set(partFor(subtitle), cues); await subtitleTranscript(output, context, subtitle, cues); }
      else { output.warnings.push(`字幕 ${subtitle.id} 为空或时间轴无效，将尝试本地语音转写`); await checkpoint(context, output); }
    } catch { output.warnings.push(`字幕 ${subtitle.id} 无法读取，将尝试本地语音转写`); await checkpoint(context, output); }
  }
  const media = originals.filter((asset) => asset.role === "video");
  const sampled: ContentAsset[] = [];
  for (const video of media) {
    if (context.signal?.aborted) break;
    context.onProgress?.(`正在提取${context.processing === "transcribe" ? "音轨" : "音轨和关键帧"} ${media.indexOf(video)+1}/${media.length}`, {phase:"媒体处理",completed:media.indexOf(video),total:media.length,unit:"个视频"});
    sampled.push(...await extractMedia(output, context, video, tools));
    const cues = goodSubtitles.get(partFor(video)); const duration = output.parts?.find((part) => part.id === video.partId)?.durationSeconds;
    if (hasCoverage(cues ?? [], duration)) {
      output.coverage = { ...output.coverage, [`subtitle:${partFor(video)}`]: "平台字幕有效且覆盖该分段" }; await checkpoint(context, output);
    } else {
      output.coverage = { ...output.coverage, [`subtitle:${partFor(video)}`]: "无有效且覆盖该分段的平台字幕，已请求本地 ASR" }; await checkpoint(context, output);
      const audio = output.assets.find((asset) => asset.id === `audio-${safeId(video.id)}`);
      if (audio?.status === "unavailable" && audio.reason === NO_AUDIO_STREAM_REASON) {
        await saveStatus(context, output, { id: `transcript-asr-${safeId(video.id)}`, role: "transcript", status: "unavailable", provenance: "machine_asr", reason: NO_AUDIO_STREAM_REASON, partId: video.partId, label: video.id });
      } else await machineAsr(output, context, video);
    }
  }
  // Imported audio is already the original ASR input; no duplicate extracted track or frames.
  for (const audio of originals.filter(asset=>asset.role==="audio"&&asset.provenance==="original")) {
    if(context.signal?.aborted)break;
    const cues=goodSubtitles.get(partFor(audio)),duration=output.parts?.find(part=>part.id===audio.partId)?.durationSeconds;
    if(hasCoverage(cues??[],duration)) {
      output.coverage={...output.coverage,[`subtitle:${partFor(audio)}`]:"平台字幕有效且覆盖该分段"};await checkpoint(context,output);
    } else {
      output.coverage={...output.coverage,[`subtitle:${partFor(audio)}`]:"无有效且覆盖该分段的平台字幕，已请求本地 ASR"};await checkpoint(context,output);
      await machineAsr(output,context,audio);
    }
  }
  // extractMedia returns audio and frames; only still images are valid OCR inputs.
  const ocrSources = context.processing === "transcribe" ? (hasVideo?[]:originals.filter(asset=>asset.role==="image")) : [...originals.filter((asset) => asset.role === "image"), ...sampled.filter((asset) => asset.role === "frame")];
  for (const [index,source] of ocrSources.entries()) { if (context.signal?.aborted) break;context.onProgress?.(`正在 OCR ${index+1}/${ocrSources.length}`,{phase:"图片文字识别",completed:index,total:ocrSources.length,unit:"张图片"}); await ocrAsset(output, context, source, !!tools.get("ocr")); context.onProgress?.(`已处理 ${index+1}/${ocrSources.length} 张图片`,{phase:"图片文字识别",completed:index+1,total:ocrSources.length,unit:"张图片"}); }
  if (context.signal?.aborted && !output.warnings.some((warning) => /取消/.test(warning))) { output.warnings.push("媒体处理已取消；已完成资料可在下次重试时复用"); await checkpoint(context, output); }
  return output;
}

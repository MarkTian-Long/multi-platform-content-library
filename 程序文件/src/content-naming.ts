import type { CapturedContent, ContentAsset } from "./content-types.js";

type AssetWithCapturePath = ContentAsset & { capturePath?: string };

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const INVALID_WINDOWS = /[<>:"/\\|?*\x00-\x1f\x7f-\x9f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu;

function codePoints(value: string): string[] { return Array.from(value); }
function truncate(value: string, maximum: number): string { return codePoints(value).slice(0, Math.max(1, maximum)).join(""); }
function fileExtension(value: string): string {
  const name = value.replace(/\\/g, "/").split("/").pop() ?? "";
  const offset = name.lastIndexOf(".");
  return offset > 0 ? name.slice(offset) : "";
}
function stemAndExtension(value: string): { stem: string; extension: string } {
  const extension = fileExtension(value);
  return { stem: extension ? value.slice(0, -extension.length) : value, extension };
}

/** A display-safe Windows filename that preserves Chinese and other NFC Unicode text. */
export function safeFilename(value: string, fallback = "未命名", maxLength = 80): string {
  const maximum = Math.max(1, Math.floor(maxLength) || 80);
  const clean = (input: string) => input.normalize("NFC").replace(INVALID_WINDOWS, "").replace(/\s+/gu," ").replace(/[\s.]+$/gu, "").trim();
  let name = clean(value) || clean(fallback) || "未命名";
  if (name === "." || name === "..") name = clean(fallback) || "未命名";
  let { stem, extension } = stemAndExtension(name);
  stem = stem.replace(/[\s.]+$/gu, "") || "未命名";
  extension = extension.replace(INVALID_WINDOWS, "").replace(/[\s.]+$/gu, "");
  if (codePoints(extension).length >= maximum) extension = "";
  const stemLimit = Math.max(1, maximum - codePoints(extension).length);
  stem=truncate(stem,stemLimit).replace(/[\s.]+$/gu,"")||truncate("未命名",stemLimit);
  if(WINDOWS_RESERVED.test(stem.split(".")[0].trim()))stem=truncate("_"+stem,stemLimit);
  return `${stem}${extension}`.replace(/[\s.]+$/gu, "");
}

const platformName: Record<CapturedContent["platform"], string> = {
  wechat: "微信", xiaohongshu: "小红书", bilibili: "B站", web: "网页"
};

export function contentFolderName(record: Pick<CapturedContent, "title" | "platform">, id: string): string {
  const title = safeFilename(record.title, "未命名资料", 40);
  return `${platformName[record.platform]} - ${title} [${safeFilename(id.slice(0, 8), "资料").slice(0, 8)}]`;
}

const categoryByRole: Record<ContentAsset["role"], string> = {
  video: "视频", audio: "音频", image: "图片", cover: "封面", subtitle: "字幕", transcript: "文字稿", frame: "截图", ocr: "图片文字",
  comments: "评论", danmaku: "弹幕", source: "来源资料", reading: "来源资料", pdf: "阅读"
};
const roleName: Record<ContentAsset["role"], string> = {
  video: "视频", audio: "音频", image: "图片", cover: "封面", subtitle: "字幕", transcript: "文字稿", frame: "截图", ocr: "图片文字",
  comments: "评论", danmaku: "弹幕", source: "来源资料", reading: "阅读资料", pdf: "阅读 PDF"
};
const defaultExtension: Partial<Record<ContentAsset["role"], string>> = {
  video: ".mp4", audio: ".m4a", image: ".jpg", cover: ".jpg", subtitle: ".srt", transcript: ".md", frame: ".jpg", ocr: ".md", comments: ".json", danmaku: ".xml", source: ".json", pdf: ".pdf"
};

function timeName(milliseconds: number | undefined): string {
  const seconds = Math.max(0, Math.floor((milliseconds ?? 0) / 1_000));
  const hours = Math.floor(seconds / 3_600); const minutes = Math.floor((seconds % 3_600) / 60);
  return `${String(hours).padStart(2, "0")}-${String(minutes).padStart(2, "0")}-${String(seconds % 60).padStart(2, "0")}`;
}
function partInfo(record: CapturedContent, partId: string | undefined): { prefix: string; directory?: string } {
  const index = record.parts?.findIndex((part) => part.id === partId) ?? -1;
  if (index < 0) return { prefix: "" };
  const part = record.parts![index]; const number = `P${String(index + 1).padStart(2, "0")}`;
  const title = safeFilename(part.title, number, 28);
  return { prefix: `${number} ${title}`, directory: record.parts && record.parts.length > 1 ? `${number}-${title}` : undefined };
}
function extensionFor(asset: AssetWithCapturePath, capturePath: string): string {
  const extension = fileExtension(capturePath);
  return extension || defaultExtension[asset.role] || "";
}
function sourceStem(asset: AssetWithCapturePath, capturePath: string): string {
  const lower = capturePath.toLocaleLowerCase();
  if (lower.endsWith(".info.json")) return "视频信息";
  if (lower.endsWith(".description") || /description/i.test(capturePath)) return "简介";
  if (asset.provenance === "machine_asr") return "识别数据";
  return "来源资料";
}
function readableStem(asset: AssetWithCapturePath, capturePath: string, ordinal: number): string {
  const source = asset.provenance === "machine_asr" ? "机器" : asset.provenance === "platform_subtitle" ? "平台" : "";
  if (asset.role === "subtitle") return `字幕-${safeFilename(asset.language || "未知语言", "未知语言", 16)}-${source || "平台"}`;
  if (asset.role === "transcript") return `${source === "平台" ? "平台字幕文字稿" : source === "机器" ? "语音文字稿" : "文字稿"}`;
  if (asset.role === "frame") return `截图-${timeName(asset.startMs)}-${String(ordinal).padStart(3, "0")}`;
  if (asset.role === "ocr") return `图片文字-${timeName(asset.startMs)}-${String(ordinal).padStart(3, "0")}`;
  if (asset.role === "source" || asset.role === "reading") return sourceStem(asset, capturePath);
  return roleName[asset.role];
}
function readableLabel(asset: AssetWithCapturePath, record: CapturedContent): string {
  const part = partInfo(record, asset.partId).prefix;
  const timing = asset.role === "frame" || asset.role === "ocr" ? ` ${timeName(asset.startMs)}` : "";
  const source = asset.role === "subtitle" ? ` ${asset.provenance === "machine_asr" ? "机器" : "平台"}${asset.language ? ` ${asset.language}` : ""}` : "";
  return [part, `${roleName[asset.role]}${source}${timing}`].filter(Boolean).join(" · ");
}
function candidatePath(asset: AssetWithCapturePath, record: CapturedContent, capturePath: string, ordinal: number, pdfOrdinal: number): string {
  const extension = extensionFor(asset, capturePath);
  if (asset.role === "pdf") return safeFilename(pdfOrdinal === 1 ? `阅读${extension || ".pdf"}` : `阅读 (${pdfOrdinal})${extension || ".pdf"}`, "阅读.pdf", 72);
  const category = categoryByRole[asset.role]; const part = partInfo(record, asset.partId).directory;
  const stem = readableStem(asset, capturePath, ordinal);
  const title=record.parts?.find(part=>part.id===asset.partId)?.title||record.title;
  const mainStem=["video","audio"].includes(asset.role)?`${roleName[asset.role]}${String(ordinal).padStart(3,"0")}-${safeFilename(title,"未命名资料",32)}`:stem;
  const filename = safeFilename(`${mainStem}${extension}`, mainStem, 72);
  return [category, part, filename].filter(Boolean).join("/");
}
function distinctPath(candidate: string, used: Set<string>): string {
  const key = candidate.toLocaleLowerCase();
  if (!used.has(key)) { used.add(key); return candidate; }
  const slash = candidate.lastIndexOf("/"); const directory = slash >= 0 ? candidate.slice(0, slash + 1) : ""; const filename = slash >= 0 ? candidate.slice(slash + 1) : candidate;
  const { stem, extension } = stemAndExtension(filename);
  for (let number = 2; number < 10_000; number += 1) {
    const next = `${directory}${safeFilename(`${stem} (${number})${extension}`, stem, 72)}`;
    if (!used.has(next.toLocaleLowerCase())) { used.add(next.toLocaleLowerCase()); return next; }
  }
  throw new Error("无法为资料分配不重复的文件名");
}

/**
 * Plan stable readable paths only. This does not rename, copy, inspect or delete files.
 * `capturePath` is retained for the later storage layer to move from its working path.
 */
export function planAssetNames(record: CapturedContent, previous: ContentAsset[] = []): ContentAsset[] {
  const prior = new Map(previous.map((asset) => [asset.id, asset as AssetWithCapturePath]));
  const used = new Set<string>(); const byCapturePath = new Map<string, string>();
  for (const asset of previous as AssetWithCapturePath[]) if (asset.status === "saved" && asset.path) {
    used.add(asset.path.toLocaleLowerCase());
    const capture = asset.capturePath ?? asset.path;
    if (!byCapturePath.has(capture)) byCapturePath.set(capture, asset.path);
  }
  const ordinals = new Map<string, number>(); let pdfOrdinal = 0;
  return record.assets.map((input) => {
    const asset = { ...input } as AssetWithCapturePath;
    const previousAsset = prior.get(asset.id);
    const capturePath = asset.capturePath ?? (asset.path && asset.path!==previousAsset?.path ? asset.path : previousAsset?.capturePath ?? asset.path);
    const ordinalKey = `${asset.role}:${asset.partId ?? "whole"}`;
    const ordinal = (ordinals.get(ordinalKey) ?? 0) + 1; ordinals.set(ordinalKey, ordinal);
    if (asset.role === "pdf") pdfOrdinal += 1;
    if (capturePath) asset.capturePath = capturePath;
    if (asset.status !== "saved" || !capturePath) { delete asset.path; return asset; }
    asset.label = readableLabel(asset, record);
    if (previousAsset?.path && fileExtension(previousAsset.path).toLowerCase()===extensionFor(asset,capturePath).toLowerCase()) { asset.path = previousAsset.path; byCapturePath.set(capturePath, asset.path); used.add(asset.path.toLocaleLowerCase()); return asset; }
    const reused = byCapturePath.get(capturePath);
    asset.path = reused ?? distinctPath(candidatePath(asset, record, capturePath, ordinal, pdfOrdinal), used);
    if (!reused) byCapturePath.set(capturePath, asset.path);
    return asset;
  });
}

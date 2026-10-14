import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { imageSize } from "image-size";
import { savePublicAsset } from "./content-network.js";
import { atomicReplace, containedFile, fileHash, publicUrl, writableFile } from "./content-library.js";
import { runContentTool, type ContentToolRunResult } from "./content-tools.js";
import { prioritizeMediaCandidates } from "./content-media-quality.js";
import type { CapturedContent, ContentAsset, ContentContext } from "./content-types.js";

/** One element of the exact original post's photo list, including missing elements. */
export interface MediaCandidate {
  url: string;
  source: "provided" | "platform_object";
  rendition: "original" | "playback" | "download" | "preview" | "unknown";
  watermark: "none" | "present" | "unknown";
  evidence?: "platform_flag" | "known_stream_type" | "known_template";
  /** Opaque declared resource identity; never a guessed media key or a signed URL. */
  resourceId?: string;
  width?: number; height?: number; bitrate?: number; durationSeconds?: number;
}
export interface PhotoMedia {
  id: string; index: number; imageUrls: string[]; motionUrls: string[];
  motionExpected: boolean; motionProtected?: boolean; durationSeconds?: number; reason?: string;
  imageCandidates?: MediaCandidate[]; motionCandidates?: MediaCandidate[];
  width?: number; height?: number;
}
export interface PhotoMediaDeps {
  saveAsset?: typeof savePublicAsset;
  probeMedia?: (file: string, context: ContentContext) => Promise<{ video: boolean; audio: boolean; durationSeconds?: number; width?: number; height?: number } | undefined>;
  runTool?: (command: string, args: string[], context: ContentContext) => Promise<ContentToolRunResult>;
  maxTotalBytes?: number; maxImageBytes?: number; maxMotionBytes?: number;
}
const MAX_PHOTOS = 128, TOTAL_MAX = 2 * 1024 * 1024 * 1024, IMAGE_MAX = 25 * 1024 * 1024;
const sourceIdentity = (value: string): string => {
  const url = new URL(publicUrl(value));
  for (const key of [...url.searchParams.keys()]) if (/^(?:x-)?(?:expires|expiration|signature|sign|sig|token|key)$/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort(); return url.toString();
};
/** Ignore access signatures when comparing declarations of the same media resource. */
export const mediaSourceIdentity = sourceIdentity;
async function probe(file: string, context: ContentContext, deps: PhotoMediaDeps) {
  if (deps.probeMedia) return deps.probeMedia(file, context);
  const names = process.platform === "win32" ? ["ffprobe.exe", "ffprobe"] : ["ffprobe"], candidates = [process.env.CONTENT_FFPROBE_PATH, ...names.map(name => path.join(context.runtimeRoot, "tools", name))];
  let command = "ffprobe";
  for (const candidate of candidates) if (candidate && await fs.stat(candidate).then(stat => stat.isFile(), () => false)) { command = candidate; break; }
  const args = ["-protocol_whitelist", "file,pipe", "-v", "error", "-f", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", file];
  const result = deps.runTool ? await deps.runTool(command, args, context) : await runContentTool({ command, args, signal: context.signal, timeoutMs: 15000, maxOutputBytes: 32000 });
  if (result.code || result.timedOut || result.cancelled || result.outputTruncated) return undefined;
  try { const data = JSON.parse(result.stdout), video = data.streams?.find((item: { codec_type: string }) => item.codec_type === "video"); return { video: !!video, audio: data.streams?.some((item: { codec_type: string }) => item.codec_type === "audio") === true, durationSeconds: Number(data.format?.duration), width: video?.width, height: video?.height }; } catch { return undefined; }
}
interface Inspection { duration?: number; width?: number; height?: number; imageFormat?: string; }
const size = (value: number | undefined) => Number.isSafeInteger(value) && value! > 0 && value! <= 32768 ? value : undefined;
async function inspect(file: string, role: "image" | "video", photo: PhotoMedia, context: ContentContext, deps: PhotoMediaDeps, preview = false): Promise<Inspection> {
  if (role === "image") {
    const dimensions = imageSize(await fs.readFile(file));
    const format = ["mif1", "msf1"].includes(dimensions.type || "") ? "heif" : ["heix", "hevc", "hevx"].includes(dimensions.type || "") ? "heic" : dimensions.type;
    if (!["jpg", "png", "gif", "webp", "avif", "bmp", "heic", "heif"].includes(format || "") || !size(dimensions.width) || !size(dimensions.height) || dimensions.width * dimensions.height > 100000000) throw new Error("图片格式或尺寸未通过原件核验");
    if (preview && ["heic", "heif"].includes(format!)) throw new Error("平台预览仍为HEIC/HEIF，本轮未取得网页可显示的预览");
    return { width: dimensions.width, height: dimensions.height, imageFormat: format };
  }
  const handle = await fs.open(file, "r"), header = Buffer.alloc(16); try { await handle.read(header, 0, 16, 0); } finally { await handle.close(); }
  if (header.toString("ascii", 4, 8) !== "ftyp") throw new Error("配套动态不是有效的MP4/MOV原件");
  const result = await probe(file, context, deps);
  if (!result) throw new Error("配套动态尚未通过视频核验，请检查ffprobe");
  if (!result.video || !Number.isFinite(result.durationSeconds) || result.durationSeconds! <= 0) throw new Error("配套动态没有可核验的视频流和时长");
  if (photo.durationSeconds && Math.abs(result.durationSeconds! - photo.durationSeconds) > Math.max(0.5, photo.durationSeconds * 0.03)) throw new Error("配套动态实测时长与原图声明不一致");
  return { duration: result.durationSeconds, width: size(result.width), height: size(result.height) };
}
async function verified(file: string, asset: ContentAsset, maximum: number): Promise<void> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > maximum || asset.bytes !== stat.size || !asset.sha256 || await fileHash(file) !== asset.sha256) throw new Error("原件大小或哈希核验失败");
}
function quality(candidate: MediaCandidate, details: Inspection, role: "image" | "video", photo: PhotoMedia, record: CapturedContent): NonNullable<ContentAsset["quality"]> {
  const expectedWidth = size(role === "image" ? photo.width ?? candidate.width : candidate.width), expectedHeight = size(role === "image" ? photo.height ?? candidate.height : candidate.height);
  const measured = details.width && details.height, declared = expectedWidth && expectedHeight;
  const matches = measured && declared && (details.width! >= expectedWidth! && details.height! >= expectedHeight! || details.width! >= expectedHeight! && details.height! >= expectedWidth!);
  return { width: details.width, height: details.height, expectedWidth, expectedHeight, source: candidate.source, rendition: candidate.rendition, watermark: candidate.watermark, evidence: candidate.evidence, resolution: measured && declared ? matches ? "matches_source" : "smaller_than_source" : "unconfirmed", resourceId: createHash("sha256").update(JSON.stringify([record.platform, record.nativeId || record.canonicalUrl, photo.index, photo.id, role, role === "video" ? candidate.resourceId || "" : ""])).digest("hex") };
}
function betterPrior(prior: ContentAsset, next: ContentAsset): boolean {
  if (!prior.quality || !next.quality) return false;
  const order = { none: 0, unknown: 1, present: 2 }, left = prior.quality, right = next.quality;
  if (order[left.watermark] !== order[right.watermark]) return order[left.watermark] < order[right.watermark];
  if (left.rendition === "original" && right.rendition !== "original") return true;
  return !!left.width && !!left.height && !!right.width && !!right.height && left.width * left.height > right.width * right.height;
}
function preserveWatermarkEvidence(current: NonNullable<ContentAsset["quality"]>, previous: ContentAsset["quality"]): void {
  if (previous?.watermark === "present" || current.watermark === "unknown" && previous?.watermark === "none") { current.watermark = previous.watermark; current.evidence = previous.evidence; }
}
async function save(candidate: MediaCandidate, stem: string, role: "image" | "video", photo: PhotoMedia, record: CapturedContent, context: ContentContext, deps: PhotoMediaDeps, maximum: number, preview = false): Promise<{ asset: ContentAsset; duration?: number }> {
  const url = candidate.url;
  const failure = (reason: string): { asset: ContentAsset } => ({ asset: { id: stem, role, status: "failed", reason, provenance: "original" } });
  let transaction: string | undefined;
  try {
    context.signal?.throwIfAborted();
    const existing = context.existing?.platform === record.platform && context.existing.nativeId === record.nativeId ? context.existing : undefined;
    const intact = (asset: ContentAsset) => asset.status === "saved" && !!asset.path && !!asset.bytes && !!asset.sha256 && !!asset.sourceUrl;
    const prior = existing?.assets.find(asset => asset.id === stem && (asset.role === role || preview && asset.role === "cover") && intact(asset))
      ?? (preview ? existing?.assets.find(asset => asset.id === stem.replace(/-preview$/, "") && asset.role === "image" && intact(asset) && sourceIdentity(asset.sourceUrl!) === sourceIdentity(url)) : undefined);
    const expected = { ...photo, durationSeconds: candidate.durationSeconds ?? photo.durationSeconds };
    const priorStem = preview && prior?.id === stem.replace(/-preview$/, "") ? prior.id : stem;
    if (prior?.sourceUrl && sourceIdentity(prior.sourceUrl) === sourceIdentity(url) && prior.path?.startsWith(`${priorStem}.`)) {
      try { const file = await containedFile(context.directory, prior.path); await verified(file, prior, maximum); const details = await inspect(file, role, expected, context, deps, preview); context.signal?.throwIfAborted(); const current = quality(candidate, details, role, photo, record); preserveWatermarkEvidence(current, prior.quality); return { asset: { ...prior, id: stem, role, sourceUrl: url, capturePath: prior.path, quality: current }, duration: details.duration }; } catch (error) { if (context.signal?.aborted) throw error; }
    }
    transaction = path.dirname(await writableFile(context.directory, `.photo-downloads/${randomUUID()}/transaction`));
    const asset = await (deps.saveAsset ?? savePublicAsset)(url, transaction, stem, role, context.signal, maximum);
    if (asset.status !== "saved" || !asset.path) return { asset: { ...asset, id: stem, role, path: undefined, provenance: "original", reason: "原件本轮未取得，已有成功资料保留" } };
    const prefix = `${stem}.`;
    if (!asset.path.startsWith(prefix) || !/^[a-z0-9]{1,8}$/.test(asset.path.slice(prefix.length))) throw new Error("原件路径与配图目标不一致");
    let file = await containedFile(transaction, asset.path); await verified(file, asset, maximum);
    const details = await inspect(file, role, expected, context, deps, preview); context.signal?.throwIfAborted();
    asset.quality = quality(candidate, details, role, photo, record);
    if (prior?.sourceUrl && prior.sha256 === asset.sha256 && sourceIdentity(prior.sourceUrl) === sourceIdentity(url)) preserveWatermarkEvidence(asset.quality, prior.quality);
    const bound = prior?.quality?.resourceId === asset.quality.resourceId && (role === "image" || !!candidate.resourceId);
    if (!preview && prior?.path && prior.sourceUrl && (bound || sourceIdentity(prior.sourceUrl) === sourceIdentity(url)) && betterPrior(prior, asset)) {
      try { const previousFile = await containedFile(context.directory, prior.path); await verified(previousFile, prior, maximum); const previousDetails = await inspect(previousFile, role, expected, context, deps, preview); context.signal?.throwIfAborted(); return { asset: { ...prior, capturePath: prior.path, reason: "本轮候选画质较低，保留已核验的同一照片更高画质原件" }, duration: previousDetails.duration }; } catch (error) { if (context.signal?.aborted) throw error; }
    }
    if (details.imageFormat && !asset.path.endsWith(`.${details.imageFormat}`)) {
      const corrected = `${stem}.${details.imageFormat}`, target = await writableFile(transaction, corrected); await atomicReplace(file, target); file = target; asset.path = corrected;
    }
    const destination = await writableFile(context.directory, asset.path); context.signal?.throwIfAborted(); await atomicReplace(file, destination);
    return { asset: { ...asset, id: stem, role, capturePath: asset.path, sourceUrl: url, provenance: "original" }, duration: details.duration };
  } catch (error) { if (context.signal?.aborted) throw error; return failure(error instanceof Error ? error.message : "原件核验失败，已有成功资料保留"); }
  finally {
    if (transaction) {
      const root = await fs.realpath(context.directory).catch(() => undefined), resolved = await fs.realpath(transaction).catch(() => undefined);
      if (root && resolved && path.dirname(resolved) === path.join(root, ".photo-downloads") && /^[0-9a-f-]{36}$/.test(path.basename(resolved)) && !await fs.lstat(transaction).then(stat => stat.isSymbolicLink(), () => true)) await fs.rm(resolved, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Rank declared versions without changing their URLs, then validate a file before replacing it. */
export async function saveBestMediaAsset(candidates: MediaCandidate[], stem: string, role: "image" | "video", photo: PhotoMedia, record: CapturedContent, context: ContentContext, deps: PhotoMediaDeps, maximum: number, preview = false): Promise<{ asset: ContentAsset; duration?: number }> {
  let result: { asset: ContentAsset; duration?: number } = { asset: { id: stem, role, status: "unavailable", provenance: "original", reason: "没有同一资源的可取得媒体地址" } };
  if (role === "video" && photo.motionProtected) return { asset: { ...result.asset, reason: "配套动态明确声明受保护或加密，未下载；原图独立保留" } };
  for (const candidate of prioritizeMediaCandidates(candidates).slice(0, 4)) { context.signal?.throwIfAborted(); result = await save(candidate, stem, role, photo, record, context, deps, maximum, preview); if (result.asset.status === "saved") break; }
  return result;
}

const declaredCandidates = (urls: string[], candidates: MediaCandidate[] | undefined) => [ ...(candidates || []), ...urls.filter(url => !candidates?.some(candidate => candidate.url === url)).map(url => ({ url, source: "provided", rendition: "unknown", watermark: "unknown" } as MediaCandidate)) ];

/** Preserve separate original pictures and motion companions, with a checkpoint after each asset. */
export async function savePhotoCollection(record: CapturedContent, photos: PhotoMedia[], context: ContentContext, deps: PhotoMediaDeps = {}): Promise<CapturedContent> {
  const maximum = Math.min(TOTAL_MAX, deps.maxTotalBytes ?? TOTAL_MAX), imageMaximum = Math.min(IMAGE_MAX, deps.maxImageBytes ?? IMAGE_MAX), motionMaximum = Math.min(TOTAL_MAX, deps.maxMotionBytes ?? TOTAL_MAX);
  if (![maximum, imageMaximum, motionMaximum].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("图集媒体预算必须是正整数");
  if (!photos.length) {
    record.assets.push({ id: "images/unknown", role: "image", status: "unavailable", provenance: "original", reason: "原帖图集图片列表未取得，覆盖范围未知" });
    record.coverage = { ...record.coverage, photos: "unknown: no original photo list", media: "unknown: photo collection unavailable" };
    await context.onCheckpoint?.(record); return record;
  }
  let used = record.assets.filter(asset => asset.status === "saved").reduce((sum, asset) => sum + (asset.bytes || 0), 0), savedImages = 0, savedMotions = 0;
  const seen = new Set<number>();
  for (const photo of photos.slice(0, MAX_PHOTOS)) {
    context.signal?.throwIfAborted();
    if (!photo.id || !Number.isSafeInteger(photo.index) || photo.index <= 0 || seen.has(photo.index)) { record.warnings.push("图集配图编号无效或重复，未标记全量保存"); continue; } seen.add(photo.index);
    const imageStem = `images/${String(photo.index).padStart(3, "0")}`, motionKey = createHash("sha256").update(`${record.platform}:${record.nativeId}:${photo.index}:${photo.id}`).digest("hex").slice(0, 16), motionStem = `photo-video/${motionKey}`, partId = `photo-motion-${motionKey}`;
    for (const role of ["image", ...(photo.motionExpected || photo.motionProtected || photo.motionUrls.length || photo.motionCandidates?.length ? ["video"] : [])] as Array<"image" | "video">) {
      context.signal?.throwIfAborted();
      const stem = role === "image" ? imageStem : motionStem, limit = Math.min(role === "image" ? imageMaximum : motionMaximum, maximum - used), urls = role === "image" ? photo.imageUrls : photo.motionProtected ? [] : photo.motionUrls, candidates = role === "video" && photo.motionProtected ? [] : declaredCandidates(urls, role === "image" ? photo.imageCandidates : photo.motionCandidates);
      let asset: ContentAsset = { id: stem, role, status: "unavailable", provenance: "original", reason: role === "video" && photo.motionProtected ? "配套动态明确声明受保护或加密，未下载；原图独立保留" : photo.reason || (role === "image" ? "原帖声明的图片没有可取得地址" : "原帖声明的实况照片未取得配套动态地址") }, duration: number | undefined;
      if (limit <= 0) asset = { ...asset, status: "skipped", reason: "图集媒体总预算已用完" };
      else if (candidates.length) {
        context.onProgress?.(`正在保存第${photo.index}张照片${role === "video" ? "的配套动态" : "原图"}`);
        const result = await saveBestMediaAsset(candidates, stem, role, photo, record, context, deps, limit); asset = result.asset; duration = result.duration;
        if (asset.status === "saved") { used += asset.bytes!; if (role === "image") savedImages++; else savedMotions++; }
      }
      asset.label = role === "image" ? `第${photo.index}张原图` : `第${photo.index}张实况照片（动态视频）`;
      if (role === "video") {
        asset.partId = partId; record.parts ??= [];
        record.parts.push({ id: partId, title: `第${photo.index}张实况照片（动态视频）`, status: asset.status === "saved" ? "saved" : "partial", durationSeconds: duration, reason: asset.status === "saved" ? undefined : asset.reason });
      }
      record.assets.push(asset); await context.onCheckpoint?.(record);
      if (role === "image" && asset.status === "saved" && /\.(?:heic|heif)$/i.test(asset.path || "")) {
        const previewCandidates = candidates.filter(candidate => candidate.source === "provided" && candidate.rendition !== "original" && candidate.url !== asset.sourceUrl).map(candidate => ({ ...candidate, rendition: "preview" as const })), previewLimit = Math.min(imageMaximum, maximum - used);
        if (previewLimit > 0 && previewCandidates.length) {
          const preview = (await saveBestMediaAsset(previewCandidates, `${imageStem}-preview`, "image", photo, record, context, deps, previewLimit, true)).asset;
          if (preview.status === "saved") { preview.role = "cover"; preview.label = `第${photo.index}张网页预览`; used += preview.bytes!; record.assets.push(preview); await context.onCheckpoint?.(record); }
        }
      }
    }
  }
  const expectedMotions = photos.filter(photo => photo.motionExpected || photo.motionProtected || photo.motionUrls.length || photo.motionCandidates?.length).length;
  if (photos.length > MAX_PHOTOS) record.warnings.push(`原帖图集超过${MAX_PHOTOS}张本轮上限，未标记全量保存`);
  record.coverage ??= {};
  record.coverage.photos = `${savedImages === photos.length ? "saved" : "unknown"}: ${savedImages}/${photos.length} original photos`;
  record.coverage.livePhotos = expectedMotions ? `${savedMotions === expectedMotions ? "saved" : "unknown"}: ${savedMotions}/${expectedMotions} photo motion companions` : "not_present: no declared photo motion companions";
  record.coverage.media = record.assets.some(asset => asset.status !== "saved") || record.warnings.length ? "unknown: some original photo media unavailable" : `saved: ${savedImages} original photos and ${savedMotions} motion companions`;
  await context.onCheckpoint?.(record); return record;
}

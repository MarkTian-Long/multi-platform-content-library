import { load } from "cheerio";
import { createHash } from "node:crypto";
import type { XiaohongshuSnapshot } from "./content-acquisition.js";
import type { MediaCandidate, PhotoMedia } from "./content-photo-media.js";
import { prioritizeMediaCandidates } from "./content-media-quality.js";

const NOTE_ROOT = "#noteContainer,.note-container,.note-detail-mask,[data-note-id]";
const EXCLUDED = "[class*=recommend],[class*=related],[class*=comment],[data-testid*=recommend],[data-testid*=related],[data-testid*=comment]";
const NON_MEDIA = ".author,[class*=avatar],.user-info,[data-testid=author]";
const URL_ATTRIBUTES = ["src", "data-src", "data-original", "data-url", "data-video-src", "data-video-url"];
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 500;

type JsonObject = Record<string, unknown>;
type PhotoSnapshot = XiaohongshuSnapshot & { photos?: PhotoMedia[]; videoProtected?: boolean; protectedVideoUrls?: string[] };
const object = (value: unknown): JsonObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

function httpUrl(value: unknown, base: string): string | undefined {
  if (!text(value)) return undefined;
  try {
    const url = new URL(text(value), base);
    return /^(https?):$/i.test(url.protocol) && !url.username && !url.password ? url.toString() : undefined;
  } catch { return undefined; }
}

function firstUrl(values: unknown[], base: string): string | undefined {
  for (const value of values) { const url = httpUrl(value, base); if (url) return url; }
  return undefined;
}

function noteIdFromUrl(finalUrl: string): string | undefined {
  try {
    const url = new URL(finalUrl);
    if (!/^(https?):$/i.test(url.protocol) || !/(^|\.)xiaohongshu\.com$/i.test(url.hostname)) return undefined;
    return /^\/(?:explore|discovery\/item)\/([a-f0-9]{24})(?:\/|$)/i.exec(url.pathname)?.[1].toLowerCase();
  } catch { return undefined; }
}

/** Isolate the JSON object after the known state assignment; never evaluate page JavaScript. */
function stateObjectSource(script: string, start: number): string | undefined {
  if (script[start] !== "{") return undefined;
  let depth = 0; let quoted = false; let escaped = false;
  for (let offset = start; offset < script.length && offset - start <= MAX_STATE_BYTES; offset++) {
    const char = script[offset];
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === "{") { if (++depth > 256) return undefined; }
    else if (char === "}" && --depth === 0) return script.slice(start, offset + 1);
  }
  return undefined;
}

/** XHS serializes absent fields as bare undefined; replace tokens outside JSON strings only. */
function normalizeUndefined(source: string): string {
  const chunks: string[] = []; let quoted = false; let escaped = false; let start = 0;
  for (let offset = 0; offset < source.length; offset++) {
    const char = source[offset];
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') { quoted = true; continue; }
    if (source.startsWith("undefined", offset) && !/[\w$]/.test(source[offset - 1] ?? "") && !/[\w$]/.test(source[offset + 9] ?? "")) {
      chunks.push(source.slice(start, offset), "null"); offset += 8; start = offset + 1;
    }
  }
  chunks.push(source.slice(start));
  return chunks.join("");
}

function noteFromState(source: string, noteId: string): JsonObject | undefined {
  const match = /(?:^|[;\r\n])\s*(?:window\.)?__INITIAL_STATE__\s*=\s*/.exec(source);
  if (!match) return undefined;
  const json = stateObjectSource(source, match.index + match[0].length);
  if (!json) return undefined;
  try {
    const state = object(JSON.parse(normalizeUndefined(json)));
    const map = object(object(state.note).noteDetailMap);
    if (!Object.hasOwn(map, noteId)) return undefined;
    const entry = object(map[noteId]);
    const note = object(entry.note);
    if (!Object.keys(note).length) return undefined;
    if ([entry.noteId, entry.note_id, note.noteId, note.note_id, note.id].some(id => id !== undefined && id !== null && id !== "" && text(id).toLowerCase() !== noteId)) return undefined;
    return note;
  } catch { return undefined; }
}

/** State media uses explicit CDN URLs; an opaque file ID is never turned into a guessed URL. */
function stateUrls(values: unknown[], base: string): string[] {
  return [...new Set(values.flatMap(value => {
    if (!/^(?:https?:\/\/|\/\/)/i.test(text(value))) return [];
    const url = httpUrl(value, base);
    return url ? [url] : [];
  }))];
}

const IMAGE_RESOURCE = /^notes_pre_post\/[A-Za-z0-9_-]{16,160}$/;
function imageResourceFromUrl(value: string, platformOnly = true): string | undefined {
  const url = new URL(value);
  if (platformOnly && !/(^|\.)(?:xhscdn\.com|xiaohongshu\.com)$/i.test(url.hostname)) return undefined;
  return /(?:^|\/)(notes_pre_post\/[A-Za-z0-9_-]{16,160})(?:!.*)?$/.exec(url.pathname)?.[1];
}
const mediaResourceId = (kind: "image" | "motion", key: string): string => createHash("sha256").update(`xiaohongshu:${kind}:${key}`).digest("hex").slice(0, 32);

/** Fixed platform object mapping from a supplied resource identity; supplied URLs remain untouched. */
export function xiaohongshuOriginalImageCandidates(imageUrls: string[], explicitFileId?: string): MediaCandidate[] {
  const provided = stateUrls(imageUrls.slice(0, 256), "https://www.xiaohongshu.com/");
  const resources = [...new Set(provided.flatMap(url => imageResourceFromUrl(url, false) ?? []))];
  const explicit = explicitFileId && IMAGE_RESOURCE.test(explicitFileId) ? explicitFileId : undefined;
  if (resources.length > 1 || explicit && resources.some(resource => resource !== explicit)) return [];
  const resource = explicit || (explicitFileId ? undefined : provided.map(url => imageResourceFromUrl(url)).find(Boolean));
  const objectUrls = resource ? [`https://sns-img-bd.xhscdn.com/${resource}`, `https://ci.xiaohongshu.com/${resource}`] : [];
  const resourceId = resource ? mediaResourceId("image", resource) : undefined;
  const candidates: MediaCandidate[] = objectUrls.filter(url => !provided.includes(url)).map(url => ({ url, source: "platform_object", rendition: "original", watermark: "unknown", evidence: "known_template", resourceId }));
  candidates.push(...provided.map((url): MediaCandidate => ({ url, source: "provided", rendition: objectUrls.includes(url) ? "original" : "unknown", watermark: "unknown", ...(resourceId ? { resourceId } : {}), ...(objectUrls.includes(url) ? { evidence: "known_template" as const } : {}) })));
  return prioritizeMediaCandidates(candidates);
}

function declaredIds(value: JsonObject, keys: string[]): string[] {
  return keys.filter(key => value[key] !== undefined && value[key] !== null && value[key] !== "").map(key => text(value[key]));
}

function boundIdentity(value: JsonObject, noteId: string, imageId?: string): boolean {
  const notes = declaredIds(value, ["noteId", "note_id"]);
  const images = declaredIds(value, ["imageId", "image_id"]);
  return notes.every(id => id.toLowerCase() === noteId) && images.every(id => !!id && (!imageId || id === imageId)) && new Set(images).size <= 1;
}

/** Only explicit affirmative declarations in known protection fields reject a motion candidate. */
function protectedMotion(value: JsonObject): boolean {
  return ["has_drm", "is_drm", "encrypted", "hasDrm"].some(key => value[key] === true || value[key] === 1 || typeof value[key] === "string" && /^(?:true|1)$/i.test(value[key].trim()));
}

const positiveNumber = (value: unknown): number | undefined => {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : undefined;
  return number !== undefined && Number.isFinite(number) && number > 0 ? number : undefined;
};
const dimension = (value: unknown): number | undefined => {
  const number = positiveNumber(value);
  return number !== undefined && Number.isSafeInteger(number) && number <= 32768 ? number : undefined;
};
function candidateMetadata(item: JsonObject): Partial<MediaCandidate> {
  const width = dimension(item.width), height = dimension(item.height), bitrate = positiveNumber(item.videoBitrate) ?? positiveNumber(item.avgBitrate), duration = positiveNumber(item.duration);
  return { ...(width ? { width } : {}), ...(height ? { height } : {}), ...(bitrate ? { bitrate } : {}), ...(duration ? { durationSeconds: duration / 1000 } : {}) };
}
function originCandidate(value: unknown, base: string): MediaCandidate | undefined {
  const key = text(value);
  if (!key || key.length > 2048) return undefined;
  if (/^(?:https?:\/\/|\/\/)/i.test(key)) {
    const url = stateUrls([key], base)[0];
    return url ? { url, source: "provided", rendition: "original", watermark: "unknown", evidence: "platform_flag", resourceId: mediaResourceId("motion", url) } : undefined;
  }
  const resource = key.replace(/^\/(?!\/)/, "");
  if (resource.length > 512 || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]{1,8})?$/.test(resource)) return undefined;
  return { url: `https://sns-video-bd.xhscdn.com/${resource}`, source: "platform_object", rendition: "original", watermark: "unknown", evidence: "known_template", resourceId: mediaResourceId("motion", resource) };
}

type MotionRecord = { candidate: MediaCandidate; protected: boolean };
type MotionData = { records: MotionRecord[]; expected: boolean; wholeProtected: boolean; declaredProtected: boolean; identityMismatch: boolean };
/** Inspect only the selected component's own known media containers and explicit original Key. */
function motionData(owner: JsonObject, noteId: string, base: string, imageId?: string, photo = false): MotionData {
  const originals: MotionRecord[] = [], main: MotionRecord[] = [], backups: MotionRecord[] = [];
  let expected = false, wholeProtected = false, declaredProtected = false, identityMismatch = false;
  const components = [owner, ...(photo && Object.keys(object(owner.livePhoto)).length ? [object(owner.livePhoto)] : [])];
  for (const component of components) {
    if (!boundIdentity(component, noteId, imageId)) { identityMismatch = true; expected = true; continue; }
    if (component !== owner) expected = true;
    wholeProtected ||= protectedMotion(component);
    const media = object(component.media);
    const validMedia = boundIdentity(media, noteId, imageId);
    if (!validMedia) identityMismatch = true;
    else wholeProtected ||= protectedMotion(media);
    for (const stream of [object(component.stream), ...(validMedia ? [object(media.stream)] : [])]) {
      if ([stream.h264, stream.h265, stream.h266, stream.av1].some(value => Array.isArray(value) ? value.length > 0 : Object.keys(object(value)).length > 0)) expected = true;
      if (!boundIdentity(stream, noteId, imageId)) { identityMismatch = true; continue; }
      wholeProtected ||= protectedMotion(stream);
      for (const codec of ["h264", "h265"]) {
        const rows = (Array.isArray(stream[codec]) ? stream[codec].slice(0, 32) : Object.keys(object(stream[codec])).length ? [stream[codec]] : []).map(object);
        for (const item of rows) {
          if (!boundIdentity(item, noteId, imageId)) { identityMismatch = true; continue; }
          declaredProtected ||= protectedMotion(item);
          const streamType = positiveNumber(item.streamType);
          const logo = streamType === 19 || streamType === 259 || streamType === 309 || text(item.streamDesc).toUpperCase() === "WEB_LIVEPHOTO_19";
          const rendition = streamType === 19 || text(item.streamDesc).toUpperCase() === "WEB_LIVEPHOTO_19" ? "preview" : streamType === 259 || streamType === 309 ? "download" : "playback";
          const properties: Omit<MediaCandidate, "url"> = { source: "provided", rendition, watermark: logo ? "present" : "unknown", ...(logo ? { evidence: "known_stream_type" } : {}), ...candidateMetadata(item) };
          const urls = stateUrls([item.masterUrl, item.mainUrl, item.url], base);
          const alternate = [...urls.slice(1), ...stateUrls(Array.isArray(item.backupUrls) ? item.backupUrls.slice(0, 16) : [], base)];
          if (urls[0]) main.push({ candidate: { url: urls[0], ...properties }, protected: protectedMotion(item) });
          for (const url of alternate) backups.push({ candidate: { url, ...properties }, protected: protectedMotion(item) });
        }
      }
    }
    for (const source of [component, object(component.consumer)]) {
      if (!text(source.originVideoKey)) continue;
      expected = true;
      if (!boundIdentity(source, noteId, imageId)) { identityMismatch = true; continue; }
      declaredProtected ||= protectedMotion(source);
      const candidate = originCandidate(source.originVideoKey, base);
      if (candidate) originals.push({ candidate, protected: protectedMotion(source) });
    }
    if (!photo) {
      for (const url of stateUrls([component.mainUrl, component.masterUrl, component.src, component.url, ...(validMedia ? [media.mainUrl, media.masterUrl] : [])], base)) {
        main.push({ candidate: { url, source: "provided", rendition: "playback", watermark: "unknown" }, protected: false });
      }
    }
  }
  return { records: [...originals, ...main, ...backups], expected, wholeProtected, declaredProtected, identityMismatch };
}
function collectProtected(data: MotionData, protectedUrls: Set<string>): void {
  for (const record of data.records) if (data.wholeProtected || record.protected) protectedUrls.add(record.candidate.url);
}
function playableCandidates(data: MotionData, protectedUrls: ReadonlySet<string>): MediaCandidate[] {
  return data.wholeProtected ? [] : prioritizeMediaCandidates(data.records.filter(record => !record.protected && !protectedUrls.has(record.candidate.url)).map(record => record.candidate));
}

function statePhotos(note: JsonObject, noteId: string, base: string, protectedUrls: Set<string>): { photos: PhotoMedia[]; imageIdentityRejected: boolean } {
  if (!Array.isArray(note.imageList)) return { photos: [], imageIdentityRejected: false };
  let imageIdentityRejected = false;
  const entries = note.imageList.slice(0, MAX_IMAGES).map((value, offset) => {
    const image = object(value), index = offset + 1;
    const fallbackId = `${noteId}:image:${index}`;
    // fileId identifies an uploaded image resource; imageId and renderer id can be different namespaces.
    const fileIds = declaredIds(image, ["fileId", "file_id"]);
    const imageIds = declaredIds(image, ["imageId", "image_id"]);
    const imageId = imageIds[0];
    const id = fileIds[0] || imageId || text(image.id) || fallbackId;
    const data = motionData(image, noteId, base, imageId, true);
    const motionExpected = image.livePhoto === true || image.livePhoto === 1 || image.livePhoto === "true" || image.livePhoto === "1"
      || data.expected;
    const allInfo = Array.isArray(image.infoList) ? image.infoList.slice(0, 32).map(object) : [];
    const info = allInfo.filter(item => boundIdentity(item, noteId, imageId));
    const suppliedImages = stateUrls([image.urlDefault, image.url, ...info.filter(item => item.imageScene === "WB_DFT").map(item => item.url), image.urlPre, ...info.map(item => item.url), typeof value === "string" ? value : undefined], base);
    const originals = xiaohongshuOriginalImageCandidates(suppliedImages, fileIds[0]);
    const validIdentity = boundIdentity(image, noteId, imageId) && [...fileIds, ...imageIds].every(value => !!value && value.length <= 512) && new Set(fileIds).size <= 1 && id.length <= 512 && (!suppliedImages.length || originals.length > 0);
    return { image, index, fallbackId, imageId, id, info, suppliedImages, originals, data, motionExpected, validIdentity };
  });
  // Collect every identity-matched protection declaration before resolving any photo, regardless of order.
  for (const entry of entries) {
    if (!entry.validIdentity) continue;
    collectProtected(entry.data, protectedUrls);
  }
  const photos = entries.map(({ image, index, fallbackId, id, info, suppliedImages, originals, data, motionExpected, validIdentity }): PhotoMedia => {
    if (!validIdentity) {
      imageIdentityRejected = true;
      return { id: fallbackId, index, imageUrls: [], motionUrls: [], motionExpected, reason: "该照片的笔记、图片或资源身份字段矛盾，未采集其媒体" };
    }
    const width = dimension(image.width), height = dimension(image.height);
    const imageCandidates = prioritizeMediaCandidates(originals.map(candidate => {
      if (candidate.rendition === "original") return { ...candidate, ...(width ? { width } : {}), ...(height ? { height } : {}) };
      const supplied = info.find(item => httpUrl(item.url, base) === candidate.url);
      const preview = candidate.url === httpUrl(image.urlPre, base) || supplied?.imageScene === "WB_PRV";
      return { ...candidate, ...(preview ? { rendition: "preview" as const } : {}), ...(supplied ? { ...(dimension(supplied.width) ? { width: dimension(supplied.width) } : {}), ...(dimension(supplied.height) ? { height: dimension(supplied.height) } : {}) } : {}) };
    }));
    const imageUrls = imageCandidates.map(candidate => candidate.url);
    if (!imageUrls.length && suppliedImages.length) imageIdentityRejected = true;
    const motionCandidates = playableCandidates(data, protectedUrls);
    const motionUrls = motionCandidates.map(candidate => candidate.url);
    const motionProtected = data.wholeProtected || !motionUrls.length && (data.declaredProtected || data.records.some(record => protectedUrls.has(record.candidate.url)));
    const durationSeconds = motionCandidates[0]?.durationSeconds;
    const reasons: string[] = [];
    if (!imageUrls.length) reasons.push(suppliedImages.length ? "该照片原图候选的资源身份矛盾，未混合采集" : "未取得该照片的原图地址");
    if (motionExpected && !motionUrls.length) reasons.push(motionProtected ? "该照片的实况动态明确声明受保护或加密，未采集" : data.identityMismatch ? "实况动态的身份字段与目标照片不符，未采集" : "该照片已声明实况，但未取得可下载的 H.264/H.265 动态地址");
    return { id, index, imageUrls, motionUrls, motionExpected, imageCandidates, motionCandidates, ...(width ? { width } : {}), ...(height ? { height } : {}), ...(motionProtected ? { motionProtected: true } : {}), ...(durationSeconds !== undefined ? { durationSeconds } : {}), ...(reasons.length ? { reason: reasons.join("；") } : {}) };
  });
  if (note.imageList.length > MAX_IMAGES) photos.push({
    id: `${noteId}:image-overflow`, index: MAX_IMAGES + 1, imageUrls: [], motionUrls: [], motionExpected: false,
    reason: `原图集声明 ${note.imageList.length} 张照片；本次仅解析前 ${MAX_IMAGES} 张，超出范围的原件与动态未取得`
  });
  return { photos, imageIdentityRejected };
}

/** Parse one URL-matched note, using rendered media first and bounded note state as a fallback. */
export function extractXiaohongshuSnapshot(html: string, finalUrl: string): PhotoSnapshot {
  const empty: XiaohongshuSnapshot = { finalUrl, title: "", body: "", images: [], videos: [] };
  const noteId = noteIdFromUrl(finalUrl);
  if (!noteId) return empty;
  const $ = load(html);
  const roots = $(NOTE_ROOT).filter((_, node) => !$(node).closest(EXCLUDED).length);
  const nodes = roots.toArray();
  const leaves = roots.filter((_, node) => !nodes.some(other => other !== node && $(node).find(other).length > 0));
  const matching = leaves.filter((_, node) => text($(node).closest("[data-note-id]").attr("data-note-id")).toLowerCase() === noteId);
  const hasExplicitIds = leaves.toArray().some(node => !!text($(node).closest("[data-note-id]").attr("data-note-id")));
  const selected = matching.length === 1 ? matching : !hasExplicitIds && leaves.length === 1 ? leaves : undefined;
  let rendered = empty;
  let renderedVideo = false;
  if (selected) {
    const root = selected.clone();
    root.find(`${EXCLUDED},script,style,noscript,iframe`).remove();
    root.find("[data-note-id]").filter((_, node) => text($(node).attr("data-note-id")).toLowerCase() !== noteId).remove();
    const bodyRoot = root.find(".note-content,#detail-desc,[data-testid=note-content],.desc,.content").first().clone();
    bodyRoot.find(NON_MEDIA).remove();
    const title = root.find("h1,#detail-title,.title").first().text().trim();
    const author = root.find(".user-name,.username,[data-testid=author],.author").first().text().trim() || undefined;
    const mediaRoot = root.clone(); mediaRoot.find(NON_MEDIA).remove();
    renderedVideo = mediaRoot.find("video").length > 0;
    const imageNodes = [...mediaRoot.find(".note-media img,[data-testid*=media] img").toArray(), ...mediaRoot.children("img").toArray()];
    const images = [...new Set(imageNodes.slice(0, MAX_IMAGES).flatMap(node => {
      const url = firstUrl(["data-src", "data-original", "src"].map(name => $(node).attr(name)), finalUrl);
      return url ? [url] : [];
    }))];
    const videos = [...new Set(mediaRoot.find("video").toArray().flatMap(node => {
      const player = $(node);
      const candidates = [...URL_ATTRIBUTES.map(name => player.attr(name)), ...player.find("source").toArray().flatMap(source => URL_ATTRIBUTES.map(name => $(source).attr(name)))];
      const url = firstUrl(candidates, finalUrl);
      return url ? [url] : [];
    }))];
    rendered = { finalUrl, title, author, body: bodyRoot.text().trim(), images, videos };
  }
  const stateNotes = $("script").toArray().flatMap(node => {
    const note = noteFromState($(node).text(), noteId);
    return note ? [note] : [];
  });
  // Multiple conflicting state assignments are ambiguous; a uniquely rendered note can still stand alone.
  const note = stateNotes.length === 1 ? stateNotes[0] : undefined;
  if (!note) return renderedVideo&&!rendered.videos.length?{...rendered,videoExpected:true}:rendered;
  const protectedUrls = new Set<string>();
  const noteVideo = motionData(object(note.video), noteId, finalUrl);
  collectProtected(noteVideo, protectedUrls);
  const { photos, imageIdentityRejected } = statePhotos(note, noteId, finalUrl, protectedUrls);
  const images = [...new Set(photos.flatMap(photo => photo.imageUrls.slice(0, 1)))];
  const photoMotion = new Set(photos.flatMap(photo => photo.motionUrls));
  const gallery = note.type === "normal" || photos.some(photo => photo.motionExpected) && note.type !== "video" && !Object.keys(object(note.video)).length;
  const videoProtected = !gallery && noteVideo.wholeProtected;
  const renderedVideos = videoProtected ? [] : rendered.videos.filter(url => !photoMotion.has(url) && !protectedUrls.has(url));
  const videoCandidates = gallery || videoProtected ? [] : prioritizeMediaCandidates([...playableCandidates(noteVideo, protectedUrls).filter(candidate => !photoMotion.has(candidate.url)), ...renderedVideos.map((url): MediaCandidate => ({ url, source: "provided", rendition: "playback", watermark: "unknown" }))]);
  // Legacy videos stays one source for state variants; videoCandidates describes the same resource's fallbacks.
  const videos = gallery || videoProtected ? [] : renderedVideos.length ? renderedVideos : videoCandidates.slice(0, 1).map(candidate => candidate.url);
  const videoExpected = !gallery && (renderedVideo || note.type === "video" || (note.type !== "normal" && Object.keys(object(note.video)).length > 0));
  return {
    finalUrl,
    title: rendered.title || text(note.title),
    author: rendered.author || text(object(note.user).nickname) || undefined,
    body: rendered.body || text(note.desc),
    images: images.length ? images : imageIdentityRejected ? [] : rendered.images,
    videos,
    ...(protectedUrls.size ? { protectedVideoUrls: [...protectedUrls] } : {}),
    ...(videoProtected ? { videoProtected: true, videoCandidates: [] } : {}),
    ...(videoCandidates.length ? { videoCandidates } : {}),
    ...(photos.length ? { photos } : {}),
    ...(videoExpected&&!videos.length?{videoExpected:true}:{})
  };
}

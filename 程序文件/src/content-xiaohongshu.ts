import { load } from "cheerio";
import type { XiaohongshuSnapshot } from "./content-acquisition.js";
import type { PhotoMedia } from "./content-photo-media.js";

const NOTE_ROOT = "#noteContainer,.note-container,.note-detail-mask,[data-note-id]";
const EXCLUDED = "[class*=recommend],[class*=related],[class*=comment],[data-testid*=recommend],[data-testid*=related],[data-testid*=comment]";
const NON_MEDIA = ".author,[class*=avatar],.user-info,[data-testid=author]";
const URL_ATTRIBUTES = ["src", "data-src", "data-original", "data-url", "data-video-src", "data-video-url"];
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 500;

type JsonObject = Record<string, unknown>;
type PhotoSnapshot = XiaohongshuSnapshot & { photos?: PhotoMedia[] };
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

function statePhotos(note: JsonObject, noteId: string, base: string, protectedUrls: Set<string>): PhotoMedia[] {
  if (!Array.isArray(note.imageList)) return [];
  const entries = note.imageList.slice(0, MAX_IMAGES).map((value, offset) => {
    const image = object(value), index = offset + 1;
    const fallbackId = `${noteId}:image:${index}`;
    // fileId identifies an uploaded image resource; imageId and renderer id can be different namespaces.
    const fileIds = declaredIds(image, ["fileId", "file_id"]);
    const imageIds = declaredIds(image, ["imageId", "image_id"]);
    const imageId = imageIds[0];
    const id = fileIds[0] || imageId || text(image.id) || fallbackId;
    const stream = object(image.stream);
    const h264 = (Array.isArray(stream.h264) ? stream.h264.slice(0, 32) : Object.keys(object(stream.h264)).length ? [stream.h264] : []).map(object);
    const motionExpected = image.livePhoto === true || image.livePhoto === 1 || image.livePhoto === "true" || image.livePhoto === "1"
      || [stream.h264, stream.h265, stream.av1].some(value => Array.isArray(value) ? value.length > 0 : Object.keys(object(value)).length > 0);
    const validIdentity = boundIdentity(image, noteId, imageId) && [...fileIds, ...imageIds].every(value => !!value && value.length <= 512) && new Set(fileIds).size <= 1 && id.length <= 512;
    const identityStreams = h264.filter(item => boundIdentity(item, noteId, imageId));
    const protectedScope = protectedMotion(image) || protectedMotion(stream);
    const candidates = identityStreams.map(item => ({ item, urls: stateUrls([item.masterUrl, item.mainUrl, ...(Array.isArray(item.backupUrls) ? item.backupUrls.slice(0, 16) : [])], base) }));
    return { value, image, index, fallbackId, imageId, id, h264, motionExpected, validIdentity, protectedScope, candidates };
  });
  // Collect every identity-matched protection declaration before resolving any photo, regardless of order.
  for (const entry of entries) {
    if (!entry.validIdentity) continue;
    for (const candidate of entry.candidates.filter(candidate => entry.protectedScope || protectedMotion(candidate.item))) {
      for (const url of candidate.urls) protectedUrls.add(url);
    }
  }
  const photos = entries.map(({ value, image, index, fallbackId, imageId, id, h264, motionExpected, validIdentity, protectedScope, candidates }): PhotoMedia => {
    if (!validIdentity) {
      return { id: fallbackId, index, imageUrls: [], motionUrls: [], motionExpected, reason: "该照片的笔记或图片身份字段矛盾，未采集其媒体" };
    }
    const allInfo = Array.isArray(image.infoList) ? image.infoList.slice(0, 32).map(object) : [];
    const info = allInfo.filter(item => boundIdentity(item, noteId, imageId));
    const imageUrls = stateUrls([image.urlDefault, image.url, ...info.filter(item => item.imageScene === "WB_DFT").map(item => item.url), image.urlPre, ...info.map(item => item.url), typeof value === "string" ? value : undefined], base);
    const matchingStreams = protectedScope ? [] : candidates.filter(candidate => !protectedMotion(candidate.item)).map(candidate => ({ item: candidate.item, urls: candidate.urls.filter(url => !protectedUrls.has(url)) }));
    const motionUrls = [...new Set(matchingStreams.flatMap(candidate => candidate.urls))];
    const motionProtected = protectedScope || !motionUrls.length && candidates.some(candidate => protectedMotion(candidate.item) || candidate.urls.some(url => protectedUrls.has(url)));
    const timedStream = matchingStreams.find(candidate => candidate.urls.length > 0)?.item;
    const durationMs = typeof timedStream?.duration === "number" ? timedStream.duration : typeof timedStream?.duration === "string" && /^\d+(?:\.\d+)?$/.test(timedStream.duration) ? Number(timedStream.duration) : undefined;
    const durationSeconds = durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : undefined;
    const reasons: string[] = [];
    if (!imageUrls.length) reasons.push("未取得该照片的原图地址");
    if (motionExpected && !motionUrls.length) reasons.push(motionProtected ? "该照片的实况动态明确声明受保护或加密，未采集" : candidates.length !== h264.length ? "实况动态的身份字段与目标照片不符，未采集" : "该照片已声明实况，但未取得可下载的 H.264 动态地址");
    return { id, index, imageUrls, motionUrls, motionExpected, ...(motionProtected ? { motionProtected: true } : {}), ...(durationSeconds !== undefined ? { durationSeconds } : {}), ...(reasons.length ? { reason: reasons.join("；") } : {}) };
  });
  if (note.imageList.length > MAX_IMAGES) photos.push({
    id: `${noteId}:image-overflow`, index: MAX_IMAGES + 1, imageUrls: [], motionUrls: [], motionExpected: false,
    reason: `原图集声明 ${note.imageList.length} 张照片；本次仅解析前 ${MAX_IMAGES} 张，超出范围的原件与动态未取得`
  });
  return photos;
}

function stateVideo(note: JsonObject, base: string, protectedUrls?: ReadonlySet<string>): string[] {
  const video = object(note.video);
  const stream = object(object(video.media).stream);
  const h264 = Array.isArray(stream.h264) ? stream.h264.slice(0, 32) : [stream.h264];
  const h265 = Array.isArray(stream.h265) ? stream.h265.slice(0, 32) : [stream.h265];
  const variants = [...h264,...h265].map(object).flatMap(item => [item.masterUrl, item.mainUrl, ...(Array.isArray(item.backupUrls) ? item.backupUrls.slice(0, 16) : [])]);
  const candidates = [...variants, video.mainUrl, video.masterUrl, object(video.media).mainUrl, object(video.media).masterUrl, video.src, video.url];
  const url = firstUrl(candidates.filter(value => !protectedUrls?.has(httpUrl(value, base) ?? "")), base);
  // Variants represent the same video; save one playable source rather than every quality.
  return url ? [url] : [];
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
  const photos = statePhotos(note, noteId, finalUrl, protectedUrls);
  const images = [...new Set(photos.flatMap(photo => photo.imageUrls.slice(0, 1)))];
  const photoMotion = new Set(photos.flatMap(photo => photo.motionUrls));
  const gallery = note.type === "normal" || photos.some(photo => photo.motionExpected) && note.type !== "video" && !Object.keys(object(note.video)).length;
  const renderedVideos = rendered.videos.filter(url => !photoMotion.has(url) && !protectedUrls.has(url));
  const videos = gallery ? [] : renderedVideos.length ? renderedVideos : stateVideo(note, finalUrl, protectedUrls);
  const videoExpected = !gallery && (renderedVideo || note.type === "video" || (note.type !== "normal" && Object.keys(object(note.video)).length > 0));
  return {
    finalUrl,
    title: rendered.title || text(note.title),
    author: rendered.author || text(object(note.user).nickname) || undefined,
    body: rendered.body || text(note.desc),
    images: images.length ? images : rendered.images,
    videos,
    ...(photos.length ? { photos } : {}),
    ...(videoExpected&&!videos.length?{videoExpected:true}:{})
  };
}

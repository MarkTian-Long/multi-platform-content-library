import { load } from "cheerio";
import type { XiaohongshuSnapshot } from "./content-acquisition.js";

const NOTE_ROOT = "#noteContainer,.note-container,.note-detail-mask,[data-note-id]";
const EXCLUDED = "[class*=recommend],[class*=related],[class*=comment],[data-testid*=recommend],[data-testid*=related],[data-testid*=comment]";
const NON_MEDIA = ".author,[class*=avatar],.user-info,[data-testid=author]";
const URL_ATTRIBUTES = ["src", "data-src", "data-original", "data-url", "data-video-src", "data-video-url"];
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 500;

type JsonObject = Record<string, unknown>;
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
    const note = object(object(map[noteId]).note);
    if (!Object.keys(note).length) return undefined;
    if ([note.noteId, note.id].some(id => text(id) && text(id).toLowerCase() !== noteId)) return undefined;
    return note;
  } catch { return undefined; }
}

function stateImages(note: JsonObject, base: string): string[] {
  if (!Array.isArray(note.imageList)) return [];
  return [...new Set(note.imageList.slice(0, MAX_IMAGES).flatMap(value => {
    const image = object(value);
    const info = Array.isArray(image.infoList) ? image.infoList.slice(0, 32).map(object) : [];
    const url = firstUrl([image.urlDefault, image.url, ...info.filter(item => item.imageScene === "WB_DFT").map(item => item.url), image.urlPre, ...info.map(item => item.url), typeof value === "string" ? value : undefined], base);
    return url ? [url] : [];
  }))];
}

function stateVideo(note: JsonObject, base: string): string[] {
  const video = object(note.video);
  const stream = object(object(video.media).stream);
  const h264 = Array.isArray(stream.h264) ? stream.h264.slice(0, 32) : [stream.h264];
  const h265 = Array.isArray(stream.h265) ? stream.h265.slice(0, 32) : [stream.h265];
  const variants = [...h264,...h265].map(object).flatMap(item => [item.masterUrl, item.mainUrl, ...(Array.isArray(item.backupUrls) ? item.backupUrls.slice(0, 16) : [])]);
  const url = firstUrl([...variants, video.mainUrl, video.masterUrl, object(video.media).mainUrl, object(video.media).masterUrl, video.src, video.url], base);
  // Variants represent the same video; save one playable source rather than every quality.
  return url ? [url] : [];
}

/** Parse one URL-matched note, using rendered media first and bounded note state as a fallback. */
export function extractXiaohongshuSnapshot(html: string, finalUrl: string): XiaohongshuSnapshot {
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
  const images = stateImages(note, finalUrl);
  const videos = rendered.videos.length ? rendered.videos : stateVideo(note, finalUrl);
  const videoExpected = renderedVideo || note.type === "video" || (note.type !== "normal" && Object.keys(object(note.video)).length > 0);
  return {
    finalUrl,
    title: rendered.title || text(note.title),
    author: rendered.author || text(object(note.user).nickname) || undefined,
    body: rendered.body || text(note.desc),
    images: images.length ? images : rendered.images,
    videos,
    ...(videoExpected&&!videos.length?{videoExpected:true}:{})
  };
}

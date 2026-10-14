import type { ContentInput, ContentPlatform } from "./content-types.js";
import { fetchPublic, fetchedPublicUrl, fetchedPublicRedirects } from "./content-network.js";
import { douyinWorkReference, weiboPostReference } from "./content-social-reference.js";
import { bilibiliDynamicReference } from "./content-bilibili-dynamic.js";

const URL_CANDIDATE = /https?:\/\/[^\s<>"'，。！？；、）】》]+/giu;
const TRAILING = /[.,;:!?)}\]，。！？；、】【》]+$/u;
const BV_IDENTIFIER = /\b(BV[0-9A-Za-z]{10})\b/giu;

/** An explicit single-video identity only; playlists, channels and live URLs are not adapters. */
export function youtubeVideoReference(value: string): { nativeId: string; canonicalUrl: string } | undefined {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) return undefined;
    const host = url.hostname.toLowerCase();
    const videoPath = url.pathname.replace(/\/+$/, "");
    let nativeId: string | undefined;
    if (["youtu.be", "www.youtu.be"].includes(host)) nativeId = /^\/([A-Za-z0-9_-]{11})$/.exec(videoPath)?.[1];
    else if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) {
      nativeId = videoPath === "/watch" && url.searchParams.getAll("v").length === 1 ? url.searchParams.get("v") ?? undefined : /^\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})$/.exec(videoPath)?.[1];
    } else if (["youtube-nocookie.com", "www.youtube-nocookie.com"].includes(host)) nativeId = /^\/embed\/([A-Za-z0-9_-]{11})$/.exec(videoPath)?.[1];
    return nativeId && /^[A-Za-z0-9_-]{11}$/.test(nativeId) ? { nativeId, canonicalUrl: `https://www.youtube.com/watch?v=${nativeId}` } : undefined;
  } catch { return undefined; }
}

function identityUrl(url: URL): string {
  const canonical = new URL(url);
  canonical.hash = "";
  for (const key of [...canonical.searchParams.keys()]) {
    if (/^(utm_|spm$|from$|share|timestamp$|token$|access_token$|key$|signature$|sign$|sn$|auth|session|code$)/i.test(key)) canonical.searchParams.delete(key);
  }
  return canonical.toString();
}

function platformFor(url: URL): { platform: ContentPlatform; nativeId?: string; canonicalUrl: string } {
  const dynamic=bilibiliDynamicReference(url.toString());
  if(dynamic)return {platform:"bilibili",nativeId:dynamic.nativeId,canonicalUrl:dynamic.canonicalUrl};
  const douyin = douyinWorkReference(url.toString());
  if (douyin) return { platform: "douyin", nativeId: douyin.nativeId, canonicalUrl: douyin.canonicalUrl };
  const weibo = weiboPostReference(url.toString());
  if (weibo) return { platform: "weibo", nativeId: weibo.nativeId, canonicalUrl: weibo.canonicalUrl };
  if (url.hostname === "v.douyin.com" && !url.port && /^\/[A-Za-z0-9_-]{1,64}\/?$/.test(url.pathname)) return { platform: "douyin", canonicalUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}` };
  const youtube = youtubeVideoReference(url.toString());
  if (youtube) return { platform: "youtube", ...youtube };
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const bv = /\/(?:video\/)?(BV[0-9A-Za-z]{10})\b/i.exec(path)?.[1];
  if (host === "bilibili.com" || host === "b23.tv") {
    const nativeId = bv?.replace(/^bv/i, "BV");
    return { platform: "bilibili", nativeId, canonicalUrl: nativeId ? `https://www.bilibili.com/video/${nativeId}` : `${url.origin}${path}` };
  }
  const xhs = /\/(?:explore|discovery\/item|item)\/([0-9a-f]{16,32})\b/i.exec(path)?.[1];
  if (host === "xiaohongshu.com" || host === "xhslink.com" || host === "xhslink.cn") return { platform: "xiaohongshu", nativeId: xhs, canonicalUrl: xhs ? `https://www.xiaohongshu.com/explore/${xhs}` : identityUrl(url) };
  const sph = host === "weixin.qq.com" ? /^\/sph\/([A-Za-z0-9]+)$/.exec(path)?.[1] : undefined;
  if (sph) return { platform: "wechat_channels", nativeId: `sph:${sph}`, canonicalUrl: `${url.origin}${path}` };
  if (host === "channels.weixin.qq.com") return { platform: "wechat_channels", canonicalUrl: identityUrl(url) };
  if (host === "mp.weixin.qq.com") return { platform: "wechat", nativeId: path === "/s" ? [url.searchParams.get("__biz"), url.searchParams.get("mid"), url.searchParams.get("idx")].filter(Boolean).join(":") || path : path, canonicalUrl: identityUrl(url) };
  return { platform: "web", canonicalUrl: identityUrl(url) };
}

function createInput(raw: string): ContentInput | undefined {
  try {
    const url = new URL(raw.replace(TRAILING, ""));
    if (!/^https?:$/i.test(url.protocol) || url.username || url.password) return undefined;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.replace(/^\[|\]$/g, "") === "::1") return undefined;
    const info = platformFor(url);
    return { url: url.toString(), ...info };
  } catch { return undefined; }
}

/** Extracts safe HTTP(S) links from pasted share text without exposing tokens in identities. */
export function parseContentLinks(text: string): ContentInput[] {
  const candidates = [
    ...[...text.matchAll(URL_CANDIDATE)].map((match) => createInput(match[0])),
    ...[...text.matchAll(BV_IDENTIFIER)].map((match) => createInput(`https://www.bilibili.com/video/${match[1]}`))
  ].filter((value): value is ContentInput => !!value);
  const seen = new Set<string>();
  return candidates.filter((input) => {
    const key = `${input.platform}:${input.nativeId ?? input.canonicalUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function resolveContentInput(input: ContentInput, signal?: AbortSignal): Promise<ContentInput> {
  // Re-identify persisted jobs so old web classifications can be retried after an adapter upgrade.
  const source = createInput(input.url);
  if (!source) throw new Error("链接格式无效或不是公网链接");
  const likelyShort = /^(b23\.tv|bili2233\.cn|xhslink\.(?:com|cn)|v\.douyin\.com|t\.cn)$/i.test(new URL(source.url).hostname);
  if (!likelyShort) return source;
  let response: Response;
  try { response = await fetchPublic(source.url, { method: "GET" }, signal); }
  catch (error) { if (source.platform === "xiaohongshu" && !signal?.aborted) return source; throw error; }
  await response.body?.cancel().catch(() => {});
  const requestUrl = fetchedPublicUrl(response) || source.url;
  const resolved = createInput(requestUrl);
  if (!resolved) throw new Error("短链跳转到不受支持的地址");
  const shareHost = new URL(source.url).hostname;
  if (["v.douyin.com", "t.cn"].includes(shareHost)) {
    const targets = fetchedPublicRedirects(response).map(createInput).filter((candidate): candidate is ContentInput => !!candidate?.nativeId && ["douyin", "weibo"].includes(candidate.platform));
    const target = targets[0];
    if (target) {
      if (source.platform === "douyin" && target.platform !== "douyin" || targets.some(candidate => candidate.platform !== target.platform || candidate.nativeId !== target.nativeId && !(target.platform === "weibo" && target.nativeId!.startsWith("video:") && !candidate.nativeId!.startsWith("video:")))) throw new Error("分享短链跳转到不同目标作品或帖子");
      return target;
    }
    if (shareHost === "t.cn" && /(^|\.)weibo\.(com|cn)$/i.test(new URL(resolved.url).hostname)) throw new Error("微博短链未提供目标帖子身份；请提交单条帖子或 TV 链接");
  }
  // A public request may reach login while the dedicated browser can still open the original share.
  if (source.platform === "xiaohongshu" && !resolved.nativeId) return source;
  if (source.platform === "douyin" && resolved.platform !== "douyin") {
    const host = new URL(resolved.url).hostname;
    if (["douyin.com", "www.douyin.com", "iesdouyin.com", "www.iesdouyin.com"].includes(host)) return source;
    throw new Error("抖音短链未指向目标作品");
  }
  return resolved;
}

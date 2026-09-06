import type { ContentInput, ContentPlatform } from "./content-types.js";
import { fetchPublic, fetchedPublicUrl } from "./content-network.js";

const URL_CANDIDATE = /https?:\/\/[^\s<>"'，。！？；、）】》]+/giu;
const TRAILING = /[.,;:!?)}\]，。！？；、】【》]+$/u;
const BV_IDENTIFIER = /\b(BV[0-9A-Za-z]{10})\b/giu;

function identityUrl(url: URL): string {
  const canonical = new URL(url);
  canonical.hash = "";
  for (const key of [...canonical.searchParams.keys()]) {
    if (/^(utm_|spm$|from$|share|timestamp$|token$|access_token$|key$|signature$|sign$|sn$|auth|session|code$)/i.test(key)) canonical.searchParams.delete(key);
  }
  return canonical.toString();
}

function platformFor(url: URL): { platform: ContentPlatform; nativeId?: string; canonicalUrl: string } {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const bv = /\/(?:video\/)?(BV[0-9A-Za-z]{10})\b/i.exec(path)?.[1];
  if (host === "bilibili.com" || host === "b23.tv") {
    const nativeId = bv?.replace(/^bv/i, "BV");
    return { platform: "bilibili", nativeId, canonicalUrl: nativeId ? `https://www.bilibili.com/video/${nativeId}` : `${url.origin}${path}` };
  }
  const xhs = /\/(?:explore|discovery\/item|item)\/([0-9a-f]{16,32})\b/i.exec(path)?.[1];
  if (host === "xiaohongshu.com" || host === "xhslink.com") return { platform: "xiaohongshu", nativeId: xhs, canonicalUrl: xhs ? `https://www.xiaohongshu.com/explore/${xhs}` : identityUrl(url) };
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
  const likelyShort = /^(b23\.tv|bili2233\.cn|xhslink\.com|v\.douyin\.com)$/i.test(new URL(input.url).hostname);
  if (!likelyShort) return input;
  const response = await fetchPublic(input.url, { method: "GET" }, signal);
  await response.body?.cancel().catch(() => {});
  const requestUrl = fetchedPublicUrl(response) || input.url;
  const resolved = createInput(requestUrl);
  if (!resolved) throw new Error("短链跳转到不受支持的地址");
  return resolved;
}

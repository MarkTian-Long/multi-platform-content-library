/** Pure single-work identities. Never derive an identity from a feed/profile or tracking token. */
const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const WORK_ID = /^[1-9]\d{14,21}$/;
export type DouyinReference = { nativeId: string; canonicalUrl: string; kind: "video" | "note" };
export type WeiboReference = { nativeId: string; canonicalUrl: string; kind: "post" | "video"; mid?: string; bid?: string; fid?: string };

function publicShape(value: string): URL | undefined {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.port ? url : undefined; } catch { return undefined; }
}

export function douyinWorkReference(value: string): DouyinReference | undefined {
  const url = publicShape(value); if (!url) return undefined;
  const host = url.hostname.toLowerCase(), pathname = url.pathname.replace(/\/+$/, "") || "/";
  let id: string | undefined, kind: "video" | "note" = "video";
  if (["douyin.com", "www.douyin.com"].includes(host)) {
    const match = /^\/(video|note)\/(\d+)$/.exec(pathname);
    if (match) { id = match[2]; kind = match[1] as typeof kind; }
    else if (pathname === "/" || /^\/user\/[A-Za-z0-9_.-]+$/.test(pathname)) id = url.searchParams.getAll("modal_id").length === 1 ? url.searchParams.get("modal_id") ?? undefined : undefined;
    const modal = url.searchParams.getAll("modal_id");
    if (modal.length > 1 || modal.length === 1 && modal[0] !== id) return undefined;
  } else if (["iesdouyin.com", "www.iesdouyin.com"].includes(host)) {
    const match = /^\/share\/(video|note|slides)\/(\d+)$/.exec(pathname);
    if (match) { id = match[2]; kind = match[1] === "video" ? "video" : "note"; }
  }
  return id && WORK_ID.test(id) ? { nativeId: id, canonicalUrl: `https://www.douyin.com/${kind}/${id}`, kind } : undefined;
}

function encodeChunk(value: number): string {
  let encoded = "";
  do { encoded = BASE62[value % 62] + encoded; value = Math.floor(value / 62); } while (value);
  return encoded;
}

/** Weibo encodes decimal MID in independent 7-digit chunks, each at most four base62 digits. */
export function weiboMidToBid(mid: string): string | undefined {
  if (!/^[1-9]\d{14,19}$/.test(mid)) return undefined;
  let bid = "";
  for (let end = mid.length; end > 0; end -= 7) {
    const start = Math.max(0, end - 7), chunk = encodeChunk(Number(mid.slice(start, end)));
    bid = (start ? chunk.padStart(4, "0") : chunk) + bid;
  }
  return bid;
}

export function weiboBidToMid(bid: string): string | undefined {
  if (!/^[0-9A-Za-z]{5,12}$/.test(bid)) return undefined;
  let mid = "";
  for (let end = bid.length; end > 0; end -= 4) {
    const start = Math.max(0, end - 4);
    let chunk = 0; for (const character of bid.slice(start, end)) chunk = chunk * 62 + BASE62.indexOf(character);
    if (chunk > 9_999_999) return undefined;
    mid = (start ? String(chunk).padStart(7, "0") : String(chunk)) + mid;
  }
  return weiboMidToBid(mid) === bid ? mid : undefined;
}

export function weiboPostReference(value: string): WeiboReference | undefined {
  const url = publicShape(value); if (!url) return undefined;
  const host = url.hostname.toLowerCase();
  let pathname: string; try { pathname = decodeURIComponent(url.pathname).replace(/\/+$/, ""); } catch { return undefined; }
  let identifier: string | undefined, fid: string | undefined;
  if (["weibo.com", "www.weibo.com"].includes(host)) {
    identifier = /^\/\d+\/([A-Za-z0-9]+)$/.exec(pathname)?.[1];
    fid = /^\/tv\/show\/(\d+:(?:[0-9a-f]{32}|[1-9]\d{15,21}))$/.exec(pathname)?.[1];
  } else if (host === "m.weibo.cn") identifier = /^\/(?:status|detail)\/([A-Za-z0-9]+)$/.exec(pathname)?.[1];
  else if (host === "video.weibo.com" && pathname === "/show" && url.searchParams.getAll("fid").length === 1) fid = url.searchParams.get("fid") ?? undefined;
  if (fid && /^\d+:(?:[0-9a-f]{32}|[1-9]\d{15,21})$/.test(fid)) return { nativeId: `video:${fid}`, canonicalUrl: `https://weibo.com/tv/show/${fid}`, kind: "video", fid };
  if (!identifier) return undefined;
  const mid = /^[1-9]\d{14,19}$/.test(identifier) ? identifier : weiboBidToMid(identifier);
  const bid = mid && weiboMidToBid(mid);
  return mid && bid ? { nativeId: bid, canonicalUrl: `https://m.weibo.cn/status/${bid}`, kind: "post", mid, bid } : undefined;
}

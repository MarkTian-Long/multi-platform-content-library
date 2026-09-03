import path from "node:path";
import fs from "node:fs";

export type UrlValidation = { ok: true; url: URL } | { ok: false; reason: string };

export function validateArticleUrl(input: string): UrlValidation {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:") return { ok: false, reason: "只支持 HTTPS 链接" };
    if (url.hostname !== "mp.weixin.qq.com") return { ok: false, reason: "只支持 mp.weixin.qq.com 文章链接" };
    if (url.pathname === "/" || url.pathname.length < 2) return { ok: false, reason: "链接缺少文章路径" };
    return { ok: true, url };
  } catch {
    return { ok: false, reason: "链接格式无效" };
  }
}

export function resolveEdgeExecutable(configured?: string): string {
  const candidate = configured ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  if (!path.isAbsolute(candidate) || path.extname(candidate).toLowerCase() !== ".exe") {
    throw new Error("Edge executable must be an absolute .exe path");
  }
  if (!fs.existsSync(candidate)) throw new Error("Configured Edge executable was not found");
  return path.resolve(candidate);
}

export function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

import fs from "node:fs/promises";
import path from "node:path";

const LAYOUT_MARKER = ".library-layout.json";
const LEGACY_MARKER = ".unified-library.json";

/** Inspect an existing directory and all of its ancestors without creating it. */
async function plainDirectory(directory: string): Promise<boolean> {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const segment of path.relative(current, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) return false;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("资料库路径不允许符号链接或非目录路径");
  }
  return true;
}

async function readMarker(directory: string, name: string, label: string): Promise<Record<string, unknown> | undefined> {
  const marker = path.join(directory, name);
  const stat = await fs.lstat(marker).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return undefined;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4096) throw new Error(`${label}无效`);
  const realDirectory = await fs.realpath(directory), realMarker = await fs.realpath(marker);
  if (path.dirname(realMarker) !== realDirectory || path.basename(realMarker) !== name) throw new Error(`${label}超出资料库目录`);
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(realMarker, "utf8")); }
  catch { throw new Error(`${label}无效`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}无效`);
  return value as Record<string, unknown>;
}

async function hasCanonicalLayout(directory: string): Promise<boolean> {
  const marker = await readMarker(directory, LAYOUT_MARKER, "正式资料库布局标记");
  if (!marker) return false;
  if (marker.version !== 2 && marker.version !== 3) throw new Error("正式资料库布局标记版本无效");
  return true;
}

/**
 * Resolve only initialized canonical storage or a narrow, verified sibling mapping.
 * An archived same-project 文章库 path remains usable without recreating that directory.
 * Ordinary custom legacy roots return undefined so their existing format still works.
 */
export async function resolveUnifiedArticleRoot(root: string): Promise<string | undefined> {
  const absolute = path.resolve(root), exists = await plainDirectory(absolute);
  const mapping = exists ? await readMarker(absolute, LEGACY_MARKER, "统一资料库映射") : undefined;
  if (mapping && (mapping.version !== 1 || mapping.contentRoot !== "../资料库")) {
    throw new Error("统一资料库映射必须指向同项目资料库");
  }
  if (exists && await hasCanonicalLayout(absolute)) {
    if (mapping && path.resolve(absolute, "..", "资料库") !== absolute) throw new Error("正式资料库布局与统一资料库映射冲突");
    return absolute;
  }
  if (!mapping && path.basename(absolute) !== "文章库") return undefined;
  const target = path.resolve(absolute, "..", "资料库");
  if (await plainDirectory(target) && await hasCanonicalLayout(target)) return target;
  if (mapping) throw new Error("统一资料库映射的正式资料库布局缺失");
  return undefined;
}

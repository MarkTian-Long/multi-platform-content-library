import type { ContentAsset } from "./content-types.js";

/** Selects the current local reading PDF; the caller verifies the stored file. */
export function selectReadingPdf(assets: readonly ContentAsset[]): ContentAsset | undefined {
  const candidates = assets.filter(asset => {
    if (asset.status !== "saved" || asset.integrityFailed || !asset.path) return false;
    if (asset.bytes !== undefined && (!Number.isFinite(asset.bytes) || asset.bytes <= 0)) return false;
    const relative = asset.path.replaceAll("\\", "/");
    if (relative.startsWith("/") || /[:\x00-\x1f]/.test(relative) || relative.split("/").includes("..") || !/\.pdf$/i.test(relative)) return false;
    return asset.role === "pdf" || asset.id === "legacy-pdf" || (asset.role === "source" && asset.provenance === "original");
  });
  return candidates.find(asset => asset.role === "pdf" && asset.id === "reading-pdf")
    ?? candidates.find(asset => asset.id === "legacy-pdf")
    ?? candidates.find(asset => asset.role === "pdf")
    ?? candidates[0];
}

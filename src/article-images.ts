import fs from "node:fs/promises";
import path from "node:path";
import type { ArticleImage } from "./article.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type SavedArticleImage = ArticleImage & {
  status: "saved" | "failed";
  localPath?: string;
  reason?: string;
};

export type ImageFetcher = (input: string, init?: RequestInit) => Promise<Response>;

function extensionFor(contentType: string): string {
  const subtype = contentType.split(";")[0]?.trim().toLowerCase();
  if (subtype === "image/jpeg" || subtype === "image/jpg") return "jpg";
  if (subtype === "image/png") return "png";
  if (subtype === "image/gif") return "gif";
  if (subtype === "image/webp") return "webp";
  if (subtype === "image/svg+xml") return "svg";
  return "img";
}

export async function downloadArticleImages(
  images: ArticleImage[] | undefined,
  directory: string,
  fetcher: ImageFetcher = fetch
): Promise<SavedArticleImage[]> {
  await fs.mkdir(directory, { recursive: true });
  const result: SavedArticleImage[] = [];
  for (const image of images ?? []) {
    try {
      const response = await fetcher(image.sourceUrl, { signal: AbortSignal.timeout(30_000) });
      const contentType = response.headers.get("content-type") ?? "";
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!contentType.toLowerCase().startsWith("image/")) throw new Error("返回内容不是图片");
      if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) throw new Error("图片超过 10 MB 限制");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("图片超过 10 MB 限制");
      const localPath = `images/${String(image.index).padStart(3, "0")}.${extensionFor(contentType)}`;
      await fs.writeFile(path.join(directory, path.basename(localPath)), bytes);
      result.push({ ...image, status: "saved", localPath });
    } catch (error) {
      result.push({ ...image, status: "failed", reason: error instanceof Error ? error.message : "图片下载失败" });
    }
  }
  return result;
}
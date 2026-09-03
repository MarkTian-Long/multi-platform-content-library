import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as cheerio from "cheerio";
import { chromium } from "playwright-core";
import type { ArticleManifest } from "./article-library.js";
import { resolveEdgeExecutable } from "./url-policy.js";

export type PdfStatus = { status: "saved"; path: string } | { status: "failed"; reason: string };
export type PdfGenerator = (html: string) => Promise<Uint8Array>;

export function buildPdfHtml(sourceHtml: string, manifest: ArticleManifest, articleDirectory: string): string {
  const $ = cheerio.load(sourceHtml);
  const content = $("#js_content").first();
  for (const image of manifest.images ?? []) {
    if (image.status !== "saved" || !image.localPath) continue;
    const localPath = image.localPath;
    content.find("img").each((_, node) => {
      const element = $(node);
      const candidates = ["data-src", "data-original", "data-actualsrc", "src"].map((key) => element.attr(key));
      if (candidates.includes(image.sourceUrl)) element.attr("src", pathToFileURL(path.join(articleDirectory, localPath)).toString());
    });
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:"Microsoft YaHei",sans-serif;max-width:760px;margin:40px auto;line-height:1.75;color:#202124}h1{line-height:1.35}img{display:block;max-width:100%;height:auto;margin:18px auto}pre,blockquote{white-space:pre-wrap;background:#f6f8fa;padding:12px;border-left:4px solid #9aa0a6}a{color:#2463b8}footer{margin-top:30px;color:#666;font-size:12px}</style></head><body><h1>${manifest.title}</h1><p>来源：${manifest.sourceUrl}</p>${content.html() ?? ""}<footer>本地保存时间：${manifest.extractedAt}</footer></body></html>`;
}

async function defaultPdfGenerator(html: string): Promise<Uint8Array> {
  const browser = await chromium.launch({ executablePath: resolveEdgeExecutable(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    return new Uint8Array(await page.pdf({ format: "A4", printBackground: true, margin: { top: "18mm", right: "16mm", bottom: "18mm", left: "16mm" } }));
  } finally { await browser.close(); }
}

export async function generateArticlePdf(directory: string, manifest: ArticleManifest, generator: PdfGenerator = defaultPdfGenerator): Promise<PdfStatus> {
  try {
    const html = buildPdfHtml(await fs.readFile(path.join(directory, "source.html"), "utf8"), manifest, directory);
    const output = path.join(directory, "文章.pdf");
    await fs.writeFile(output, await generator(html));
    return { status: "saved", path: "文章.pdf" };
  } catch (error) { return { status: "failed", reason: error instanceof Error ? error.message : "PDF 生成失败" }; }
}

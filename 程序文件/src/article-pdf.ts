import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as cheerio from "cheerio";
import { chromium } from "playwright-core";
import { articleFileName, type ArticleManifest } from "./article-library.js";
import { resolveEdgeExecutable } from "./url-policy.js";
import { closeQuietly, describeError } from "./errors.js";
import crypto from "node:crypto";

export type PdfStatus = { status: "saved"; path: string } | { status: "failed"; reason: string };
export type PdfGenerator = (html: string) => Promise<Uint8Array>;

export function recordPdfAttempt(manifest: ArticleManifest, result: PdfStatus): void {
  if (result.status === "saved") {
    manifest.pdf = result;
    delete manifest.lastPdfError;
  } else {
    // A failed attempt leaves both the previous PDF file and its UI entry usable.
    if (manifest.pdf?.status !== "saved") manifest.pdf = result;
    manifest.lastPdfError = result.reason;
  }
}

export function buildPdfHtml(sourceHtml: string, manifest: ArticleManifest, articleDirectory: string): string {
  const $ = cheerio.load(sourceHtml);
  const content = $("#js_content").first();
  for (const video of manifest.videos ?? []) {
    const text = video.status === "saved" && video.localPath ? `视频 ${video.index}：已保存为 ${video.localPath}。PDF 不支持播放视频，请从文章文件夹打开。原文：${video.sourceArticleUrl}` : `视频 ${video.index}：未离线保存，PDF 不支持播放视频。请在原文观看：${video.sourceArticleUrl}`;
    const placeholder = content.find(`[data-article-video-index="${video.index}"]`);
    if (placeholder.length) placeholder.text(text); else content.append($("<p></p>").text(text));
  }
  content.find("script, style, link, iframe, object, embed, video, mp-video, audio, source, form, noscript, svg, canvas").remove();
  for (const node of content.find("p, section, div").toArray().reverse()) {
    const block = $(node);
    if (!block.text().trim() && !block.find("img, table, hr").length) block.remove();
  }
  content.find("*").each((_, node) => {
    if (!("attribs" in node)) return;
    for (const attribute of Object.keys(node.attribs)) {
      if (attribute.toLowerCase().startsWith("on") || ["style", "srcset", "poster", "background", "srcdoc"].includes(attribute.toLowerCase())) $(node).removeAttr(attribute);
    }
  });
  content.find("a").each((_, node) => { const href = $(node).attr("href") ?? ""; if (!/^https?:\/\//i.test(href)) $(node).removeAttr("href"); });
  content.find("img").each((_, node) => {
    const image = $(node);
    const candidates = ["data-src", "data-original", "data-actualsrc", "src"].map((key) => image.attr(key));
    const saved = manifest.images?.find((entry) => entry.status === "saved" && entry.localPath && candidates.includes(entry.sourceUrl));
    for (const key of ["data-src", "data-original", "data-actualsrc", "src"]) image.removeAttr(key);
    if (saved?.localPath) image.attr("src", pathToFileURL(path.join(articleDirectory, saved.localPath)).toString());
    else image.attr("alt", `${image.attr("alt") ?? "图片"}（未离线保存）`);
  });
  for (const image of manifest.images ?? []) {
    if (image.status !== "saved" || !image.localPath) continue;
    const localPath = image.localPath;
    content.find("img").each((_, node) => {
      const element = $(node);
      const candidates = ["data-src", "data-original", "data-actualsrc", "src"].map((key) => element.attr(key));
      if (candidates.includes(image.sourceUrl)) element.attr("src", pathToFileURL(path.join(articleDirectory, localPath)).toString());
    });
  }
  const escapeText = (value: string) => $("<span></span>").text(value).html() ?? "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: file:; style-src 'unsafe-inline'"><style>body{font-family:"Microsoft YaHei",sans-serif;max-width:760px;margin:40px auto;line-height:1.75;color:#202124}h1{line-height:1.35}h1,h2,h3,h4,h5{break-after:avoid}p{orphans:3;widows:3}img{display:block;max-width:100%;max-height:145mm;width:auto;height:auto;object-fit:contain;break-inside:avoid;margin:18px auto}pre,blockquote{white-space:pre-wrap;background:#f6f8fa;padding:12px;border-left:4px solid #9aa0a6}a{color:#2463b8}footer{margin-top:30px;color:#666;font-size:12px}</style></head><body><h1>${escapeText(manifest.title)}</h1><p>来源：${escapeText(manifest.sourceUrl)}</p>${content.html() ?? ""}<footer>本地保存时间：${escapeText(manifest.extractedAt)}</footer></body></html>`;
}

async function embedLocalImages(html: string, manifest: ArticleManifest, articleDirectory: string): Promise<string> {
  const $ = cheerio.load(html);
  for (const image of manifest.images ?? []) {
    if (image.status !== "saved" || !image.localPath) continue;
    try {
      const bytes = await fs.readFile(path.join(articleDirectory, image.localPath));
      const extension = path.extname(image.localPath).slice(1).toLowerCase() || "png";
      const mime = extension === "jpg" ? "jpeg" : extension;
      $("img").each((_, node) => {
        const element = $(node);
        const candidates = ["data-src", "data-original", "data-actualsrc", "src"].map((key) => element.attr(key));
        if (candidates.includes(image.sourceUrl) || candidates.includes(pathToFileURL(path.join(articleDirectory, image.localPath!)).toString())) element.attr("src", `data:image/${mime};base64,${bytes.toString("base64")}`);
      });
    } catch { /* keep the original image reference if local evidence is unavailable */ }
  }
  return $.html();
}

async function defaultPdfGenerator(html: string): Promise<Uint8Array> {
  const browser = await chromium.launch({ executablePath: resolveEdgeExecutable(), headless: true });
  try {
    const page = await browser.newPage({ javaScriptEnabled: false });
    await page.route("**/*", (route) => route.abort());
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    return new Uint8Array(await page.pdf({ format: "A4", printBackground: true, margin: { top: "18mm", right: "16mm", bottom: "18mm", left: "16mm" } }));
  } finally { await closeQuietly(browser); }
}

export async function generateArticlePdf(directory: string, manifest: ArticleManifest, generator: PdfGenerator = defaultPdfGenerator): Promise<PdfStatus> {
  const temporary = path.join(directory, `.pdf-${crypto.randomUUID()}.tmp`);
  try {
    const html = await embedLocalImages(buildPdfHtml(await fs.readFile(path.join(directory, "source.html"), "utf8"), manifest, directory), manifest, directory);
    const fileName = articleFileName(manifest.title, "pdf");
    const output = path.join(directory, fileName);
    await fs.writeFile(temporary, await generator(html));
    await fs.rename(temporary, output);
    return { status: "saved", path: fileName };
  } catch (error) { return { status: "failed", reason: describeError(error, "PDF 生成") }; }
  finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

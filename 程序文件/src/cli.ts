import path from "node:path";
import { fileURLToPath } from "node:url";
import { findArticleDirectory, findArticles, readArticle } from "./article-library.js";
import { resolveLibraryRoot, resolveRuntimeRoot } from "./config.js";
import { captureWechatArticle, regenerateSavedPdf, type CaptureResult } from "./mcp/handlers.js";
import { describeError, isTimeoutError } from "./errors.js";

export type CliOutput = CaptureResult & { ok: boolean; directory?: string; articles?: unknown[]; message: string };
export type CliDeps = { capture?: (url: string) => Promise<CaptureResult>; locate?: (articleId: string) => Promise<string | undefined>; };
const libraryRoot = () => resolveLibraryRoot(resolveRuntimeRoot());

export async function runCli(args: string[], deps: CliDeps = {}): Promise<CliOutput> {
  try {
  if (args[0] === "list") return { ok: true, status: "complete", articles: await findArticles(libraryRoot(), args.slice(1).join(" ")), message: "文章库已读取" };
  if (args[0] === "regenerate-pdf" && args[1]) { const pdf = await regenerateSavedPdf(args[1]); return { ok: pdf.status === "saved", status: pdf.status === "saved" ? "complete" : "failed", pdf, message: pdf.status === "saved" ? "PDF 已生成" : pdf.reason }; }
  if (args[0] !== "capture" || !args[1]) return { ok: false, status: "failed", message: "用法：capture <微信公众号文章链接>、list [关键词]、regenerate-pdf <文章标识>" };
  const result = await captureWechatArticle({ url: args[1] }, { capture: deps.capture });
  const directory = result.articleId ? await (deps.locate ?? ((articleId) => findArticleDirectory(libraryRoot(), articleId)))(result.articleId) : undefined;
  const ok = Boolean(result.articleId && ["complete", "partial"].includes(result.status));
  if (!ok) return { ...result, ok, directory, message: result.reason ?? "未能读取文章" };
  const stored = result.articleId ? await readArticle(libraryRoot(), result.articleId) : undefined;
  const images = stored && stored.ok ? stored.manifest.images ?? [] : [];
  const videos = stored && stored.ok ? stored.manifest.videos ?? [] : [];
  const imageSummary = result.imageSummary ?? { total: images.length, saved: images.filter((image) => image.status === "saved").length, failed: images.filter((image) => image.status === "failed").length };
  const videoSummary = result.videoSummary ?? { total: videos.length, saved: videos.filter((video) => video.status === "saved").length, failed: videos.filter((video) => video.status !== "saved").length };
  const warnings: string[] = [];
  if (result.pdf?.status !== "saved") warnings.push(result.pdf?.status === "failed" ? `PDF 未生成：${result.pdf.reason}` : "PDF 尚未确认生成");
  if (imageSummary.failed) warnings.push(`图片已保存 ${imageSummary.saved}/${imageSummary.total}，${imageSummary.failed} 张失败`);
  if (videoSummary.failed) warnings.push(`视频已保存 ${videoSummary.saved}/${videoSummary.total}，${videoSummary.failed} 个未保存，可通过原文入口观看`);
  if (result.status === "partial" && !warnings.length) warnings.push(result.reason ?? "部分文章信息不完整");
  const assets = [imageSummary.total && !imageSummary.failed ? `${imageSummary.saved} 张图片` : "", videoSummary.total && !videoSummary.failed ? `${videoSummary.saved} 个视频` : ""].filter(Boolean).join("、");
  const partialDetails = [...warnings];
  if (imageSummary.total && !imageSummary.failed) partialDetails.push(`图片已保存 ${imageSummary.saved}/${imageSummary.total}`);
  if (videoSummary.total && !videoSummary.failed) partialDetails.push(`视频已保存 ${videoSummary.saved}/${videoSummary.total}`);
  const message = warnings.length ? `文章已保存；${result.pdf?.status === "saved" ? "PDF 已生成；" : ""}${partialDetails.join("；")}` : `文章与 PDF 已保存到本地${assets ? `，${assets}已保存` : ""}`;
  return { ...result, status: warnings.length ? "partial" : "complete", ok, directory, imageSummary, videoSummary, message };
  } catch (error) {
    return { ok: false, status: isTimeoutError(error) ? "timeout" : "failed", message: describeError(error, "读取程序") };
  }
}
if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) runCli(process.argv.slice(2)).then((result) => { process.stdout.write(JSON.stringify(result) + "\n"); if (!result.ok) process.exitCode = 1; });

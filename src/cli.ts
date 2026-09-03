import path from "node:path";
import { fileURLToPath } from "node:url";
import { findArticleDirectory, readArticle } from "./article-library.js";
import { resolveLibraryRoot, resolveRuntimeRoot } from "./config.js";
import { captureWechatArticle, type CaptureResult } from "./mcp/handlers.js";

export type CliOutput = CaptureResult & { ok: boolean; directory?: string; imageSummary?: { total: number; saved: number; failed: number }; message: string };
export type CliDeps = {
  capture?: (url: string) => Promise<CaptureResult>;
  locate?: (articleId: string) => Promise<string | undefined>;
};

export async function runCli(args: string[], deps: CliDeps = {}): Promise<CliOutput> {
  if (args[0] !== "capture" || !args[1]) return { ok: false, status: "failed", message: "用法：capture <微信公众号文章链接>" };
  const result = await captureWechatArticle({ url: args[1] }, { capture: deps.capture });
  const directory = result.articleId
    ? await (deps.locate ?? ((articleId) => findArticleDirectory(resolveLibraryRoot(resolveRuntimeRoot()), articleId)))(result.articleId)
    : undefined;
  const ok = Boolean(result.articleId && ["complete", "partial"].includes(result.status));
  const stored = result.articleId ? await readArticle(resolveLibraryRoot(resolveRuntimeRoot()), result.articleId) : undefined;
  const images = stored && stored.ok ? stored.manifest.images ?? [] : [];
  const imageSummary = ok ? { total: images.length, saved: images.filter((image) => image.status === "saved").length, failed: images.filter((image) => image.status === "failed").length } : undefined;
  return {
    ...result,
    ok,
    directory,
    imageSummary,
    message: ok ? (directory ? "文章已保存到本地" : "文章已保存到本地，可在文章库中查看") : (result.reason ?? "未能读取文章")
  };
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  runCli(process.argv.slice(2)).then((result) => {
    process.stdout.write(JSON.stringify(result) + "\n");
    if (!result.ok) process.exitCode = 1;
  }).catch(() => {
    process.stdout.write(JSON.stringify({ ok: false, status: "failed", message: "读取程序发生错误" }) + "\n");
    process.exitCode = 1;
  });
}
import { chromium, type BrowserContext, type Page } from "playwright-core";
import path from "node:path";
import { resolveEdgeExecutable } from "../url-policy.js";
import { closeQuietly, ReaderError } from "../errors.js";

export async function openEdgePage(workspaceRoot: string, configuredExecutable?: string): Promise<{ context: BrowserContext; page: Page }> {
  let context: BrowserContext | undefined;
  try {
    const executablePath = resolveEdgeExecutable(configuredExecutable);
    context = await chromium.launchPersistentContext(path.resolve(workspaceRoot, ".wechat-reader-profile"), { executablePath, headless: false });
    const page = await context.newPage();
    return { context, page };
  } catch (error) {
    if (context) await closeQuietly(context);
    throw new ReaderError("启动专用 Edge", error);
  }
}

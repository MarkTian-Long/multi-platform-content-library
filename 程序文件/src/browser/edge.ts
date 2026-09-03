import { chromium, type BrowserContext, type Page } from "playwright-core";
import path from "node:path";
import { resolveEdgeExecutable } from "../url-policy.js";

export async function openEdgePage(workspaceRoot: string, configuredExecutable?: string): Promise<{ context: BrowserContext; page: Page }> {
  const executablePath = resolveEdgeExecutable(configuredExecutable);
  const context = await chromium.launchPersistentContext(path.resolve(workspaceRoot, ".wechat-reader-profile"), { executablePath, headless: false });
  const page = await context.newPage();
  return { context, page };
}

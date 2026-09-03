import path from "node:path";

export function resolveLibraryRoot(workspaceRoot: string): string {
  return path.resolve(workspaceRoot, "文章库");
}

export function resolveRuntimeRoot(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd()
): string {
  const configuredRoot = env.WECHAT_ARTICLE_READER_ROOT?.trim();
  return configuredRoot && path.isAbsolute(configuredRoot) ? path.resolve(configuredRoot) : path.resolve(cwd);
}

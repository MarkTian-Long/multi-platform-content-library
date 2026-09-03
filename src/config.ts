import path from "node:path";

export function resolveLibraryRoot(workspaceRoot: string): string {
  return path.resolve(workspaceRoot, "article-library");
}

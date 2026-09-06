export class ReaderError extends Error {
  constructor(stage: string, error: unknown) { super(describeError(error, stage), { cause: error }); }
}

/** Keep actionable error evidence without copying browser logs or article credentials. */
export function describeError(error: unknown, stage: string): string {
  if (error instanceof ReaderError) return error.message;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "未知错误";
  const code = message.match(/\b(?:net::)?ERR_[A-Z_0-9]+\b|\b(?:EACCES|EPERM|ENOENT|ENOSPC|ECONNREFUSED|ECONNRESET)\b/)?.[0]
    ?? (error && typeof error === "object" && "code" in error ? String(error.code) : undefined);
  if (code?.includes("ERR_NETWORK_ACCESS_DENIED")) return `${stage}失败：网络访问被拒绝（${code}），请检查专用 Edge 的网络权限和代理设置。`;
  if (code?.includes("ERR_PROXY_CONNECTION_FAILED") || code?.includes("ERR_TUNNEL_CONNECTION_FAILED")) return `${stage}失败：代理连接失败（${code}），请检查当前代理是否可用。`;
  if (code?.includes("ERR_NAME_NOT_RESOLVED")) return `${stage}失败：无法解析网站地址（${code}），请检查网络和 DNS。`;
  if (code === "EACCES" || code === "EPERM") return `${stage}失败：操作被拒绝，请检查程序或文件访问权限（${code}）。`;
  if (code === "ENOSPC") return `${stage}失败：磁盘空间不足（ENOSPC）。`;
  if (/ProcessSingleton|SingletonLock|user data directory is already in use/i.test(message)) return `${stage}失败：专用 Edge 配置正在被另一个阅读任务使用，请关闭该任务的浏览器后重试。`;
  if (/Configured Edge executable was not found/i.test(message)) return `${stage}失败：未找到 Microsoft Edge，请确认浏览器已安装。`;
  if (/timeout|timed out/i.test(message)) return `${stage}超时，请检查网络，或在专用 Edge 中确认页面是否要求验证。${code ? `（${code}）` : ""}`;
  const detail = message.split(/\r?\n/)[0]
    .replace(/(?:https?|file):\/\/[^\s<>"']+/gi, "[链接已隐藏]")
    .replace(/\b(token|key|pass_ticket|uin|cookie|authorization|password)\s*[=:]\s*[^\s,;]+/gi, "$1=[已隐藏]")
    .replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 360);
  return `${stage}失败：${detail || "未知错误"}${code && !detail.includes(code) ? `（${code}）` : ""}`;
}

export function isTimeoutError(error: unknown): boolean {
  return /timeout|timed out/i.test(error instanceof Error ? error.message : String(error));
}

export async function closeQuietly(resource: { close(): Promise<unknown> }): Promise<void> {
  try { await resource.close(); } catch { /* Cleanup must not replace the captured result or original failure. */ }
}

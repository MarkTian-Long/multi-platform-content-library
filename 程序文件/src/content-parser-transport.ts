import { fetch as proxyFetch, ProxyAgent } from "undici";
import { fetchPublic, publicHttpUrl } from "./content-network.js";
import { parserEndpoint, parserProxy } from "./content-settings.js";

/** An explicit existing local proxy is used only for the configured parser, never for media URLs. */
export function videoParserTransport(proxyUrl: string): typeof fetchPublic {
  const proxy = parserProxy(proxyUrl);
  return async (value, init = {}, signal) => {
    const endpoint = parserEndpoint(String(value));
    await publicHttpUrl(endpoint, signal);
    if (init.method !== "POST" || typeof init.body !== "string") throw new Error("解析代理只处理 JSON POST 请求");
    const headers = new Headers(init.headers);
    for (const key of ["cookie", "proxy-authorization"]) headers.delete(key);
    const dispatcher = new ProxyAgent(proxy);
    try {
      const response = await proxyFetch(endpoint, { method: "POST", body: init.body, headers: Object.fromEntries(headers.entries()), dispatcher, redirect: "error", signal: signal ?? init.signal });
      const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (reader) {
          const item = await reader.read(); if (item.done) break;
          bytes += item.value.byteLength; if (bytes > 1024 * 1024) throw new Error("解析服务响应超过读取上限"); chunks.push(item.value);
        }
      } finally { await reader?.cancel().catch(() => {}); }
      return new Response([204,205,304].includes(response.status) ? null : Buffer.concat(chunks), { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
    } finally { await dispatcher.close(); }
  };
}

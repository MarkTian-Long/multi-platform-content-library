import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { captureWechatArticle, findSavedArticles, readSavedArticle } from "./handlers.js";

export function createServer(): Server {
  const server = new Server({ name: "wechat-article-local-reader", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: "capture_wechat_article", description: "通过专用本机 Edge 采集一篇公众号文章", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
    { name: "find_saved_articles", description: "按标题或关键词查找本地文章", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    { name: "read_saved_article", description: "读取本地文章 Markdown", inputSchema: { type: "object", properties: { articleId: { type: "string" } }, required: ["articleId"] } }
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    let result: unknown;
    if (request.params.name === "capture_wechat_article" && typeof args.url === "string") result = await captureWechatArticle({ url: args.url });
    else if (request.params.name === "find_saved_articles" && typeof args.query === "string") result = await findSavedArticles({ query: args.query });
    else if (request.params.name === "read_saved_article" && typeof args.articleId === "string") result = await readSavedArticle({ articleId: args.articleId });
    else return { isError: true, content: [{ type: "text", text: "参数无效或工具不存在" }] };
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
  return server;
}

export async function startServer(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

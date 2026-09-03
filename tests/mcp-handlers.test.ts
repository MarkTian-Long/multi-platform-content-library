import test from "node:test";
import assert from "node:assert/strict";
import { captureWechatArticle, findSavedArticles, readSavedArticle } from "../src/mcp/handlers.js";

test("rejects unsupported URLs before invoking capture", async () => {
  const result = await captureWechatArticle({ url: "https://example.com/article" }, { capture: async () => { throw new Error("must not call"); } });
  assert.equal(result.status, "failed");
  assert.match(result.reason ?? "", /公众号/);
});

test("handler contracts expose capture, metadata search, and markdown read", async () => {
  const deps = { capture: async () => ({ status: "complete" as const, articleId: "known-id", title: "文章标题" }), find: async () => [{ articleId: "known-id", title: "文章标题", sourceUrl: "https://mp.weixin.qq.com/s/a", status: "complete" as const, extractedAt: "2026-09-03T00:00:00.000Z" }], read: async () => ({ ok: true as const, markdown: "正文", manifest: { title: "文章标题", status: "complete" } }) };
  assert.equal((await captureWechatArticle({ url: "https://mp.weixin.qq.com/s/example" }, deps)).articleId, "known-id");
  assert.equal((await findSavedArticles({ query: "文章标题" }, deps))[0].title, "文章标题");
  assert.equal((await readSavedArticle({ articleId: "known-id" }, deps)).markdown, "正文");
});

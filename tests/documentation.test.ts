import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("documents privacy, setup, supported boundary, and all capture statuses", () => {
  const text = ["README.md", "docs/mcp-setup.md", "docs/privacy-and-failures.md"].map((file) => fs.readFileSync(file, "utf8")).join("\n");
  for (const phrase of ["默认浏览器", "剪贴板", "article-library", "mp.weixin.qq.com", "complete", "partial", "empty", "restricted", "timeout", "failed"]) assert.match(text, new RegExp(phrase));
});

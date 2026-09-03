import test from "node:test";
import assert from "node:assert/strict";
import { validateArticleUrl } from "../src/url-policy.js";

test("accepts only HTTPS article pages on the exact WeChat host", () => {
  assert.equal(validateArticleUrl("https://mp.weixin.qq.com/s/example?a=1").ok, true);
  assert.equal(validateArticleUrl("http://mp.weixin.qq.com/s/example").ok, false);
  assert.equal(validateArticleUrl("https://mp.weixin.qq.com.evil.test/s/example").ok, false);
  assert.equal(validateArticleUrl("https://example.test/article").ok, false);
});

test("rejects a root page and malformed URL safely", () => {
  assert.equal(validateArticleUrl("https://mp.weixin.qq.com/").ok, false);
  assert.equal(validateArticleUrl("not a url").ok, false);
});

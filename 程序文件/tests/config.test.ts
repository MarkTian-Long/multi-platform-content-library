import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveLibraryRoot } from "../src/config.js";

test("the default WeChat entry uses the project's canonical content library", () => {
  const runtime = path.resolve("test-project", "程序文件");
  assert.equal(resolveLibraryRoot(runtime, {}), path.resolve(runtime, "..", "资料库"));
});

test("an explicit absolute legacy library remains configured for compatibility resolution", () => {
  const custom = path.resolve("outside-project", "my-articles");
  assert.equal(resolveLibraryRoot(path.resolve("程序文件"), { WECHAT_ARTICLE_LIBRARY_ROOT: ` ${custom} ` }), custom);
});

test("relative, empty and whitespace-only overrides use the canonical default", () => {
  const runtime = path.resolve("test-project", "程序文件");
  for (const override of ["relative-articles", "", "   "]) {
    assert.equal(resolveLibraryRoot(runtime, { WECHAT_ARTICLE_LIBRARY_ROOT: override }), path.resolve(runtime, "..", "资料库"));
  }
});

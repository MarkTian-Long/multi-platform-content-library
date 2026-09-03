import test from "node:test";
import assert from "node:assert/strict";
import { resolveLibraryRoot, resolveRuntimeRoot } from "../src/config.js";

test("uses an app-owned article library below the current workspace", () => {
  assert.match(resolveLibraryRoot("D:/work/app/程序文件"), /D:[\\/]work[\\/]app[\\/]文章库$/);
});

test("uses the configured reader root instead of the MCP process directory", () => {
  assert.equal(
    resolveRuntimeRoot({ WECHAT_ARTICLE_READER_ROOT: "D:/work/wechat-reader" }, "C:/unexpected-cwd"),
    "D:\\work\\wechat-reader"
  );
});

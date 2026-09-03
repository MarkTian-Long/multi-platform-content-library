import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("ships a double-click launcher without clipboard or background monitoring", () => {
  const command = fs.readFileSync("../启动公众号文章阅读器.cmd", "utf8");
  const window = fs.readFileSync("reader-window.ps1", "utf8");
  assert.match(command, /reader-window\.ps1/);
  assert.match(window, /公众号文章阅读器/);
  assert.match(window, /dist\\cli\.js/);
  assert.match(window, /搜索已保存文章/);
  assert.match(window, /读取并生成 MD 和 PDF/);
  assert.match(window, /StandardOutputEncoding/);
  assert.doesNotMatch(window, /Get-Clipboard|Register-HotKey|NotifyIcon/);
});

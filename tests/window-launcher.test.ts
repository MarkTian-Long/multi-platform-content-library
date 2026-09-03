import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("ships a double-click launcher without clipboard or background monitoring", () => {
  const command = fs.readFileSync("启动公众号文章阅读器.cmd", "utf8");
  const window = fs.readFileSync("启动公众号文章阅读器.ps1", "utf8");
  assert.match(command, /启动公众号文章阅读器\.ps1/);
  assert.match(window, /公众号文章阅读器/);
  assert.match(window, /dist\\cli\.js/);
  assert.doesNotMatch(window, /Get-Clipboard|Register-HotKey|NotifyIcon/);
});
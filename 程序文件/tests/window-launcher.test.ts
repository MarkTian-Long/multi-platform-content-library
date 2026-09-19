import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("keeps one daily launcher and preserves the legacy launcher in the compatibility folder", () => {
  assert.deepEqual(fs.readdirSync('..').filter(name => name.endsWith('.cmd')), ['启动多平台资料库.cmd']);
  const command = fs.readFileSync("legacy/启动公众号文章阅读器.cmd", "utf8");
  const window = fs.readFileSync("reader-window.ps1", "utf8");
  assert.match(command, /reader-window\.ps1/);
  assert.match(window, /公众号文章阅读器/);
  assert.match(window, /dist\\cli\.js/);
  assert.match(window, /搜索已保存文章/);
  assert.match(window, /读取并生成 MD 和 PDF/);
  const runner = fs.readFileSync('reader-process.ps1', 'utf8');
  assert.match(runner, /StandardOutputEncoding/);
  assert.doesNotMatch(window, /Get-Clipboard|Register-HotKey|NotifyIcon/);
});

test('legacy launcher still resolves the project root after being moved', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.resolve('logs', 'legacy-launcher-'));
  const fixture = path.join(root, '中文目录 (with spaces)');
  const program = path.join(fixture, '程序文件');
  fs.mkdirSync(path.join(program, 'legacy'), { recursive: true });
  const launcher = path.join(program, 'legacy', '启动公众号文章阅读器.cmd');
  fs.copyFileSync('legacy/启动公众号文章阅读器.cmd', launcher);
  fs.writeFileSync(path.join(program, 'reader-window.ps1'), '\ufeffparam([string]$ProjectRoot)\r\n[IO.File]::WriteAllText((Join-Path $PSScriptRoot "root.txt"), $ProjectRoot)\r\n');
  try {
    const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${launcher}""`], {
      encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true, timeout: 10000,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.error ?? ''}`);
    assert.equal(fs.readFileSync(path.join(program, 'root.txt'), 'utf8'), fixture);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

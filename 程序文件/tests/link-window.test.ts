import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const programRoot = path.resolve(import.meta.dirname, '..');
const projectRoot = path.resolve(programRoot, '..');

test('链接资料库窗口和启动器存在并保留明确的入口契约', () => {
  const window = fs.readFileSync(path.join(programRoot, 'link-window.ps1'), 'utf8');
  const launcher = fs.readFileSync(path.join(projectRoot, '启动链接资料库.cmd'), 'utf8');

  assert.equal(window.charCodeAt(0), 0xfeff, 'PowerShell 中文脚本必须使用 UTF-8 BOM');
  assert.equal(launcher.charCodeAt(0), '@'.charCodeAt(0), 'CMD 启动器首字节必须是 ASCII @，不能有 BOM');
  assert.match(launcher, /^@echo off\r\n/);
  assert.match(launcher, /chcp 65001\s*>nul/i);
  assert.equal(launcher.replace(/\r\n/g, '').includes('\n'), false, 'CMD 启动器必须使用 CRLF');
  assert.match(window, /链接资料库/);
  assert.match(window, /1150|760/);
  assert.match(window, /enqueue/);
  assert.match(window, /jobs/);
  assert.match(window, /list/);
  assert.match(window, /read/);
  assert.match(window, /export/);
  assert.match(window, /doctor/);
  assert.match(window, /login/);
  assert.match(window, /Timer/);
  assert.match(window, /Stop-ReaderProcess/);
  assert.doesNotMatch(window, /Get-Clipboard|Register-HotKey|NotifyIcon|BackgroundWorker|PlaceholderText/);
  assert.match(launcher, /link-window\.ps1/);
  assert.match(launcher, /Windows PowerShell|powershell/i);
  assert.match(launcher, /node\.exe/);
  assert.match(launcher, /dist\\link-cli\.js/);
});

test('链接资料库窗口通过参数数组启动 link-cli，并把工作目录固定到程序目录', () => {
  const window = fs.readFileSync(path.join(programRoot, 'link-window.ps1'), 'utf8');
  const processHelper = fs.readFileSync(path.join(programRoot, 'reader-process.ps1'), 'utf8');
  assert.match(window, /Start-ReaderProcess/);
  assert.match(window, /dist\\link-cli\.js/);
  assert.match(window, /WECHAT_ARTICLE_READER_ROOT/);
  assert.match(window, /CONTENT_LIBRARY_ROOT/);
  assert.match(window, /\$libraryRoot\s*=\s*(?:if[\s\S]*?Join-Path\s+\$ProjectRoot\s+'资料库'|Join-Path\s+\$ProjectRoot\s+'资料库')/);
  assert.match(window, /WorkingDirectory/);
  assert.match(window, /\(@\([^)]*\$cli[^)]*\)\s*\+\s*\$Arguments\)/s);
  assert.match(window, /ConvertTo-ReaderArgument/);
  assert.match(processHelper, /UseShellExecute\s*=\s*\$false/);
  assert.match(window, /@\('cancel',\s*\$[A-Za-z]+\.id\)/);
  assert.match(window, /@\('retry',\s*\$[A-Za-z]+\.id\)/);
  assert.doesNotMatch(window, /-RuntimeRoot/);
  assert.match(window, /setup-content-tools\.ps1/);
  assert.match(window, /setup-content-tools\.ps1.*PrepareModel/s);
  assert.match(window, /Start-Process\s+powershell\.exe[\s\S]*-WindowStyle\s+Hidden/s);
  assert.match(window, /linkInstallJob/);
  assert.match(window, /安装.*完成|安装.*失败/);
  assert.match(window, /Text\s*=\s*'小红书'/);
  assert.match(window, /Value\s*=\s*'xiaohongshu'/);
  assert.match(window, /Value\s*=\s*'bilibili'/);
});

test('窗口包含队列、搜索、平台过滤、任务动作和逐项产物状态的可验证控件', () => {
  const window = fs.readFileSync(path.join(programRoot, 'link-window.ps1'), 'utf8');
  for (const label of [
    '加入队列', '开始保存', '取消任务', '重试任务', '全文搜索', '平台',
    '打开阅读页', '打开 PDF', '打开视频', '打开目录', '打开来源', '导出资料包',
    '依赖检查', '安装到应用目录', '专用浏览器登录', '产物状态'
  ]) assert.match(window, new RegExp(label));
  for (const command of ['enqueue', 'work', 'cancel', 'retry', 'list', 'export', 'doctor', 'login']) {
    assert.match(window, new RegExp("'" + command + "'|\"" + command + "\""));
  }
  assert.match(window, /loginButton\.Enabled\s*=\s*-not\s+\$busy\s+-and\s+-not\s+\$workerBusy/);
  assert.match(window, /installButton\.Enabled\s*=\s*-not\s+\$busy\s+-and\s+-not\s+\$workerBusy/);
  assert.match(window, /\[IO\.Path\]::IsPathRooted\(\$relative\)/);
  assert.match(window, /\$searchBox\.Parent\s*=\s*\$libraryGroup/);
});

test('PowerShell 5.1 离屏控件和进程测试通过', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(programRoot, 'tests', 'link-window-harness.ps1'),
    '-ProjectRoot', projectRoot
  ], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
});

test('PowerShell 5.1 窗口通过真实 link-cli 使用临时资料库完成异步集成流程', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(programRoot, 'tests', 'link-window-real-harness.ps1'),
    '-ProjectRoot', projectRoot
  ], { encoding: 'utf8', timeout: 120000, windowsHide: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.match(String(payload.workState), /completed|partial|failed|cancelled/);
});

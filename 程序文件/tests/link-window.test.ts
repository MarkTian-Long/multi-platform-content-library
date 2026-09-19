import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const programRoot = path.resolve(import.meta.dirname, '..');
const projectRoot = path.resolve(programRoot, '..');

test('真实 CMD 入口在含空格和中文的目录中正确定位后端，且启动后退出控制台', { skip: process.platform !== 'win32' }, async () => {
  const runRoot = fs.mkdtempSync(path.join(programRoot, 'logs', 'link-launcher-'));
  const fixtureRoot = path.join(runRoot, '中文路径 (with spaces)');
  const fixtureProgram = path.join(fixtureRoot, '程序文件');
  fs.mkdirSync(path.join(fixtureProgram, 'dist'), { recursive: true });
  const reportPath = path.join(fixtureProgram, 'launcher-report.json');
  const releasePath = path.join(fixtureProgram, 'release');
  const finishedPath = path.join(fixtureProgram, 'finished');
  const launcherPath = path.join(fixtureRoot, '启动多平台资料库.cmd');
  const launcher = fs.readFileSync(path.join(projectRoot, '启动多平台资料库.cmd'), 'utf8');
  // Preserve the actual CMD invocation/quoting. Only suppress the modal form in this test.
  fs.writeFileSync(launcherPath, launcher.replace(/(-File "[^"\r\n]*link-window\.ps1")/, '$1 -NoShow'));
  const windowSource = fs.readFileSync(path.join(programRoot, 'link-window.ps1'), 'utf8');
  fs.writeFileSync(path.join(fixtureProgram, 'link-window.ps1'), windowSource + `
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'launcher-report.json'), ([ordered]@{
  projectRoot = $ProjectRoot; programRoot = $programRoot; processId = $PID
  cliExists = (Test-Path -LiteralPath (Join-Path $programRoot 'dist\\link-cli.js') -PathType Leaf)
} | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
$deadline = [DateTime]::UtcNow.AddSeconds(15)
while (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'release')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
$linkTimer.Dispose()
$tooltip.Dispose()
$form.Dispose()
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'finished'), 'ok')
`);
  fs.copyFileSync(path.join(programRoot, 'reader-process.ps1'), path.join(fixtureProgram, 'reader-process.ps1'));
  fs.writeFileSync(path.join(fixtureProgram, 'dist', 'link-cli.js'), '');
  try {
    const launched = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${launcherPath}""`], {
      encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true, timeout: 10000, stdio: 'ignore',
      env: { ...process.env, CONTENT_LIBRARY_ROOT: path.join(runRoot, 'isolated-library') }
    });
    for (let attempt = 0; attempt < 100 && !fs.existsSync(reportPath); attempt++) await delay(100);
    assert.equal(launched.status, 0, `${launched.stdout}\n${launched.stderr}\n${launched.error ?? ''}`);
    assert.ok(fs.existsSync(reportPath), `CMD did not produce a startup report: ${launched.stdout}\n${launched.stderr}`);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.projectRoot, fixtureRoot);
    assert.equal(report.programRoot, fixtureProgram);
    assert.equal(report.cliExists, true, '存在的 dist/link-cli.js 不得误报缺失');
    assert.equal(fs.existsSync(finishedPath), false, 'CMD 必须先退出，不能等待窗口退出');
    assert.doesNotThrow(() => process.kill(report.processId, 0), 'CMD 退出后窗口进程必须仍在运行');
  } finally {
    fs.writeFileSync(releasePath, 'release');
    for (let attempt = 0; attempt < 100 && !fs.existsSync(finishedPath); attempt++) await delay(50);
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test('非法项目路径在初始化时停止，不再误报后端缺失或打开损坏窗口', { skip: process.platform !== 'win32' }, () => {
  const logPath = path.join(programRoot, 'logs', 'link-window.log');
  const previousLogBytes = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(programRoot, 'link-window.ps1'),
    '-NoShow', '-ProjectRoot', `${projectRoot}"`
  ], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const diagnostic = fs.readFileSync(logPath).subarray(previousLogBytes).toString('utf8');
  assert.match(diagnostic, /无法启动多平台资料库（读取项目路径）/);
  assert.match(result.stderr, /GetFullPath/);
  assert.doesNotMatch(diagnostic + result.stderr, /缺少程序文件|Test-Path/);
});

test('多平台资料库窗口和启动器存在并保留明确的入口契约', () => {
  const window = fs.readFileSync(path.join(programRoot, 'link-window.ps1'), 'utf8');
  const launcher = fs.readFileSync(path.join(projectRoot, '启动多平台资料库.cmd'), 'utf8');

  assert.equal(window.charCodeAt(0), 0xfeff, 'PowerShell 中文脚本必须使用 UTF-8 BOM');
  assert.equal(launcher.charCodeAt(0), '@'.charCodeAt(0), 'CMD 启动器首字节必须是 ASCII @，不能有 BOM');
  assert.match(launcher, /^@echo off\r\n/);
  assert.match(launcher, /chcp 65001\s*>nul/i);
  assert.equal(launcher.replace(/\r\n/g, '').includes('\n'), false, 'CMD 启动器必须使用 CRLF');
  assert.match(window, /多平台资料库/);
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

test('多平台资料库窗口通过参数数组启动 link-cli，并把工作目录固定到程序目录', () => {
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

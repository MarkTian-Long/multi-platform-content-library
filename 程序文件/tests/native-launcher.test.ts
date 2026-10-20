import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const programRoot = path.resolve(import.meta.dirname, '..');
const launcherPath = path.resolve(programRoot, '..', '多平台资料库.exe');

async function waitFor(check: () => boolean, message: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(50);
  }
  assert.fail(message);
}

function running(processId: number) {
  try { process.kill(processId, 0); return true; } catch { return false; }
}

test('构建产物是无需控制台的原生 Windows GUI 入口', { skip: process.platform !== 'win32' }, () => {
  assert.ok(fs.existsSync(launcherPath), 'npm run build 必须生成多平台资料库.exe');
  const image = fs.readFileSync(launcherPath);
  assert.equal(image.subarray(0, 2).toString('ascii'), 'MZ');
  const peOffset = image.readUInt32LE(0x3c);
  assert.equal(image.subarray(peOffset, peOffset + 4).toString('ascii'), 'PE\0\0');
  assert.equal(image.readUInt16LE(peOffset + 24 + 68), 2, '入口必须使用 Windows GUI 子系统，避免 Explorer 创建终端');
});

for (const entry of ['exe', 'real-exe'] as const) {
test(`${entry} 入口从中文和空格路径启动，PowerShell 自入口起便没有控制台窗口`, { skip: process.platform !== 'win32' }, async () => {
  const runRoot = fs.mkdtempSync(path.join(programRoot, 'logs', 'native-launcher-'));
  const fixtureRoot = path.join(runRoot, '中文路径 (with spaces)');
  const fixtureProgram = path.join(fixtureRoot, '程序文件');
  fs.mkdirSync(path.join(fixtureProgram, 'dist'), { recursive: true });
  const executable = path.join(fixtureRoot, '多平台资料库.exe');
  const reportPath = path.join(fixtureProgram, 'native-report.json');
  const releasePath = path.join(fixtureProgram, 'release');
  const finishedPath = path.join(fixtureProgram, 'finished');
  fs.copyFileSync(launcherPath, executable);
  fs.writeFileSync(path.join(fixtureProgram, 'dist', 'link-cli.js'), '');
  fs.writeFileSync(path.join(fixtureProgram, 'link-window.ps1'), '\ufeff' + String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class NativeLauncherProbe {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll")] public static extern uint GetConsoleProcessList([Out] uint[] ids, uint count);
}
"@
$ids = New-Object uint32[] 16
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'native-report.json'), (@{
  processId = $PID; console = [NativeLauncherProbe]::GetConsoleWindow().ToInt64()
  attachedCount = [NativeLauncherProbe]::GetConsoleProcessList($ids, $ids.Length)
  consoleProcesses = @($ids | Where-Object { $_ -ne 0 })
  scriptRoot = $PSScriptRoot; workingDirectory = [Environment]::CurrentDirectory
  cliExists = [IO.File]::Exists((Join-Path $PSScriptRoot 'dist\link-cli.js'))
} | ConvertTo-Json -Compress))
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'release')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'finished'), 'ok')
`);
  if (entry !== 'exe') {
    for (const name of ['reader-process.ps1', 'link-library-dialogs.ps1']) {
      fs.copyFileSync(path.join(programRoot, name), path.join(fixtureProgram, name));
    }
    fs.writeFileSync(path.join(fixtureProgram, 'dist', 'link-cli.js'), 'process.stdout.write(JSON.stringify({ok:true,message:"isolated",jobs:[],items:[]}));');
    const probeSource = fs.readFileSync(path.join(fixtureProgram, 'link-window.ps1'), 'utf8');
    const reportSource = probeSource.split('$deadline = ')[0].replace(/^\ufeff/, '');
    const realSource = fs.readFileSync(path.join(programRoot, 'link-window.ps1'), 'utf8');
    const modalCall = '  [void]$form.ShowDialog()';
    assert.equal(realSource.split(modalCall).length, 2);
    const windowProbe = String.raw`
$form.ShowInTaskbar = $false
$form.StartPosition = 'Manual'
$form.Location = New-Object Drawing.Point(-32000, -32000)
$form.add_Shown({
` + reportSource + String.raw`
})
$probeTimer = New-Object Windows.Forms.Timer
$probeTimer.Interval = 50
$probeTimer.add_Tick({
  if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'probe')) {
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'responsive'), 'UI is responding')
  }
  if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'release')) { $form.Close() }
})
$probeTimer.Start()
$form.add_FormClosed({
  $probeTimer.Stop(); $probeTimer.Dispose()
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'finished'), 'closed normally')
})
`;
    fs.writeFileSync(path.join(fixtureProgram, 'link-window.ps1'), realSource.replace(modalCall, windowProbe + modalCall));
  }
  let appId: number | undefined;
  try {
    // Do not set windowsHide: the launcher itself must suppress consoles, including when opened from Explorer.
    const result = spawnSync(executable, [], { cwd: programRoot, stdio: 'ignore', timeout: 5000 });
    assert.equal(result.status, 0, String(result.error ?? 'native launcher failed'));
    await waitFor(() => fs.existsSync(reportPath), 'PowerShell did not start via the native entry');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    appId = report.processId;
    assert.equal(report.console, 0, 'PowerShell must not create a console at all');
    // CREATE_NO_WINDOW may supply a private console object without a window; it must not share a terminal.
    assert.deepEqual(report.consoleProcesses.filter((id: number) => id !== report.processId), []);
    assert.equal(report.scriptRoot, fixtureProgram);
    assert.equal(report.workingDirectory, fixtureProgram);
    assert.equal(report.cliExists, true);
    assert.ok(running(appId!), 'native entry may exit without ending the app');
    if (entry !== 'exe') {
      fs.writeFileSync(path.join(fixtureProgram, 'probe'), 'request a UI event');
      await waitFor(() => fs.existsSync(path.join(fixtureProgram, 'responsive')), 'real GUI did not respond via the native launcher');
    }
    fs.writeFileSync(releasePath, 'close normally');
    await waitFor(() => fs.existsSync(finishedPath), 'child did not close normally');
    await waitFor(() => !running(appId!), 'child remained running after normal exit');
  } finally {
    fs.writeFileSync(releasePath, 'cleanup');
    if (appId && running(appId)) {
      for (let attempt = 0; attempt < 40 && running(appId); attempt++) await delay(50);
      if (running(appId)) process.kill(appId);
      await waitFor(() => !running(appId!), 'test child did not terminate during cleanup');
    }
    assert.equal(path.dirname(runRoot), path.join(programRoot, 'logs'));
    await fs.promises.rm(runRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
}

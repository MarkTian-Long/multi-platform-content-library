import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const programRoot = path.resolve(import.meta.dirname, '..');
const nativeProbe = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TestConsoleNative {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll")] public static extern uint GetConsoleProcessList([Out] uint[] ids, uint count);
}
"@
`;

async function waitFor(check: () => boolean, message: string, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(50);
  }
  assert.fail(message);
}

function running(processId: number) {
  try { process.kill(processId, 0); return true; } catch { return false; }
}

function writePowerShell(file: string, source: string) {
  fs.writeFileSync(file, '\ufeff' + source.replace(/\r?\n/g, '\r\n'));
}

test('关闭承载控制台后，真实窗口仍响应并可正常关闭', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  const runRoot = fs.mkdtempSync(path.join(programRoot, 'logs', 'console-lifecycle-'));
  const fixtureRoot = path.join(runRoot, '中文路径 (with spaces)');
  const fixtureProgram = path.join(fixtureRoot, '程序文件');
  fs.mkdirSync(path.join(fixtureProgram, 'dist'), { recursive: true });
  const driverReport = path.join(fixtureProgram, 'driver-ready.json');
  const appReport = path.join(fixtureProgram, 'app-ready.json');
  const acknowledged = path.join(fixtureProgram, 'app-responsive');
  const finished = path.join(fixtureProgram, 'app-finished');
  const driverPath = path.join(fixtureProgram, 'driver.ps1');
  const source = fs.readFileSync(path.join(programRoot, 'link-window.ps1'), 'utf8');
  const modalCall = '  [void]$form.ShowDialog()';
  assert.equal(source.split(modalCall).length, 2, 'fixture must exercise the real modal window');
  const probe = nativeProbe + String.raw`
$form.ShowInTaskbar = $false
$form.StartPosition = 'Manual'
$form.Location = New-Object Drawing.Point(-32000, -32000)
$form.add_Shown({
  $ids = New-Object uint32[] 16
  $attachedCount = [TestConsoleNative]::GetConsoleProcessList($ids, $ids.Length)
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'app-ready.json'), (@{
    processId = $PID; console = [TestConsoleNative]::GetConsoleWindow().ToInt64(); attachedCount = $attachedCount
  } | ConvertTo-Json -Compress))
})
$probeTimer = New-Object Windows.Forms.Timer
$probeTimer.Interval = 50
$probeTimer.add_Tick({
  if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'probe')) {
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'app-responsive'), 'UI event loop is responding')
  }
  if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'release')) { $form.Close() }
})
$probeTimer.Start()
$form.add_FormClosed({
  $probeTimer.Stop(); $probeTimer.Dispose()
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'app-finished'), 'closed normally')
})
`;
  fs.writeFileSync(path.join(fixtureProgram, 'link-window.ps1'), source.replace(modalCall, probe + modalCall));
  for (const name of ['reader-process.ps1', 'link-library-dialogs.ps1']) {
    fs.copyFileSync(path.join(programRoot, name), path.join(fixtureProgram, name));
  }
  fs.writeFileSync(path.join(fixtureProgram, 'dist', 'link-cli.js'), 'process.stdout.write(JSON.stringify({ok:true,message:"isolated",jobs:[],items:[]}));');
  writePowerShell(driverPath, nativeProbe + String.raw`
$ErrorActionPreference = 'Stop'
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = Join-Path $PSHOME 'powershell.exe'
$psi.Arguments = '-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'link-window.ps1') + '"'
$psi.WorkingDirectory = $PSScriptRoot
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $false
$psi.WindowStyle = 'Hidden'
$app = [Diagnostics.Process]::Start($psi)
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'driver-ready.json'), (@{
  processId = $PID; appId = $app.Id; console = [TestConsoleNative]::GetConsoleWindow().ToInt64()
} | ConvertTo-Json -Compress))
$deadline = [DateTime]::UtcNow.AddSeconds(35)
while ([DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
exit 2
`);
  // An explicit, headless conhost supplies a real isolated console without opening a terminal on the user's desktop.
  const host = spawn(path.join(process.env.SystemRoot!, 'System32', 'conhost.exe'), [
    '--headless', 'powershell.exe', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', driverPath,
  ], { windowsHide: true, stdio: 'pipe', env: { ...process.env, CONTENT_LIBRARY_ROOT: path.join(runRoot, 'isolated-library') } });
  const hostClosed = new Promise<void>(resolve => { host.once('close', () => resolve()); });
  let launchDiagnostic = '';
  host.stdout.on('data', chunk => { launchDiagnostic = (launchDiagnostic + chunk.toString()).slice(-4000); });
  host.stderr.on('data', chunk => { launchDiagnostic = (launchDiagnostic + chunk.toString()).slice(-4000); });
  let launchError: Error | undefined;
  host.on('error', error => { launchError = error; });
  let appId: number | undefined;
  let driverId: number | undefined;
  try {
    await waitFor(() => { assert.equal(host.exitCode, null, launchDiagnostic); return fs.existsSync(driverReport); }, `test console failed to start: ${launchError ?? ''}`);
    const driver = JSON.parse(fs.readFileSync(driverReport, 'utf8'));
    appId = driver.appId;
    driverId = driver.processId;
    assert.notEqual(driver.console, 0, 'test must start with a real attached console');
    await waitFor(() => fs.existsSync(appReport), 'real WinForms window did not initialize');
    const app = JSON.parse(fs.readFileSync(appReport, 'utf8'));
    assert.equal(app.processId, appId);
    host.stdin.end(); // Closing the pseudoconsole input models closing its terminal window.
    await waitFor(() => !running(driverId!), 'closing the test console must terminate its attached driver');
    assert.ok(running(appId!), 'closing the console terminated the application');
    fs.writeFileSync(path.join(fixtureProgram, 'probe'), 'request UI response after console closure');
    await waitFor(() => fs.existsSync(acknowledged), 'application stopped responding after console closure', 5000);
    assert.equal(app.console, 0, 'GUI must have detached its console');
    assert.equal(app.attachedCount, 0, 'GUI must not remain attached to console processes');
    fs.writeFileSync(path.join(fixtureProgram, 'release'), 'close the app normally');
    await waitFor(() => fs.existsSync(finished), 'application could not close normally', 5000);
    await waitFor(() => !running(appId!), 'application process remained after its window closed', 5000);
  } finally {
    fs.writeFileSync(path.join(fixtureProgram, 'release'), 'cleanup');
    if (appId && running(appId)) {
      for (let attempt = 0; attempt < 40 && running(appId); attempt++) await delay(50);
      if (running(appId)) process.kill(appId);
    }
    if (driverId && running(driverId)) process.kill(driverId);
    host.stdin.destroy();
    if (host.pid && running(host.pid)) host.kill();
    await Promise.race([hostClosed, delay(5000)]);
    assert.equal(path.dirname(runRoot), path.join(programRoot, 'logs'));
    await fs.promises.rm(runRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

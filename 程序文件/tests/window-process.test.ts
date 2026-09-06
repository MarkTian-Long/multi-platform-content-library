import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const scenarios = [
  ['unicode', 'preserves Chinese JSON and returns pending before completion'],
  ['stderr', 'drains large stderr concurrently without blocking stdout'],
  ['invalid', 'reports empty, invalid and malformed results with exit diagnostics'],
  ['exit-code', 'does not report success when the process exits unsuccessfully'],
  ['arguments', 'preserves quotes, backslashes, empty arguments and URL punctuation'],
  ['mock-list', 'supports list-style JSON without reading the real article library'],
  ['cancel', 'cancels only the current task and leaves another process running'],
] as const;

for (const [scenario, description] of scenarios) {
  test(`PowerShell 5.1 reader process ${description}`, { skip: process.platform !== 'win32' }, () => {
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', 'tests/window-process-harness.ps1', '-Scenario', scenario,
      '-NodeExecutable', process.execPath,
    ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.ok, true);
    assert.equal(report.scenario, scenario);
    assert.match(report.version, /^5\.1\./);
  });
}

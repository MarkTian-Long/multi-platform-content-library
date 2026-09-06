import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('PowerShell 5.1 window completes asynchronous reads, preserves partial failures and searches', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-window-ui-'));
  const program = path.join(root, '程序文件');
  await fs.mkdir(path.join(program, 'dist'), { recursive: true });
  await fs.writeFile(path.join(program, 'dist', 'cli.js'), `
    const args = process.argv.slice(2);
    const article = { articleId: 'abc', title: '中文测试文章', extractedAt: '2026-09-06', pdf: { status: 'failed' } };
    const result = args[0] === 'list'
      ? { ok: true, message: '文章库已读取', articles: args[1] === '不存在' ? [] : [article] }
      : args[1] === 'bad-url'
        ? { ok: false, status: 'failed', message: '链接格式无效' }
        : { ok: true, status: 'partial', articleId: 'abc', message: '文章已保存，但 PDF 未生成：测试失败' };
    setTimeout(() => process.stdout.write(JSON.stringify(result)), 80);
  `);
  try {
    const run = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'tests/window-ui-harness.ps1', '-ProjectRoot', root], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}\n${run.error ?? ''}`);
    assert.equal(JSON.parse(run.stdout.trim()).ok, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

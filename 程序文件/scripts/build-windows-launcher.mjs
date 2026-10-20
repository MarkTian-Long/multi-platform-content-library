import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform === 'win32') {
  const programRoot = path.resolve(import.meta.dirname, '..');
  const projectRoot = path.resolve(programRoot, '..');
  const windowsRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const compiler = ['Framework64', 'Framework']
    .map(name => path.join(windowsRoot, 'Microsoft.NET', name, 'v4.0.30319', 'csc.exe'))
    .find(candidate => fs.existsSync(candidate));
  if (!compiler) throw new Error('未找到 Windows .NET Framework C# 编译器，无法生成无控制台启动器。');
  const output = path.join(projectRoot, '多平台资料库.exe');
  const temporary = path.join(programRoot, 'dist', `native-launcher-${process.pid}.exe`);
  fs.mkdirSync(path.dirname(temporary), { recursive: true });
  try {
    const result = spawnSync(compiler, [
      '/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', '/codepage:65001',
      '/reference:System.Windows.Forms.dll', `/out:${temporary}`,
      path.join(programRoot, 'launcher', 'ContentLibraryLauncher.cs'),
    ], { encoding: 'utf8', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`原生启动器编译失败：\n${result.stdout}\n${result.stderr}`);
    fs.renameSync(temporary, output);
    process.stdout.write('已生成无控制台入口：多平台资料库.exe\n');
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

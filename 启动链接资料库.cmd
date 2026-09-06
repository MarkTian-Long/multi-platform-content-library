@echo off
chcp 65001 >nul
setlocal
set "PROJECT_ROOT=%~dp0"
where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo 未找到 Windows PowerShell 5.1，请在 Windows 系统上运行此启动器。
  pause
  exit /b 1
)
if not exist "%PROJECT_ROOT%程序文件\link-window.ps1" (
  echo 缺少程序文件\link-window.ps1，请检查项目文件是否完整。
  pause
  exit /b 1
)
where node.exe >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node.js 后再启动链接资料库。
  pause
  exit /b 1
)
if not exist "%PROJECT_ROOT%程序文件\dist\link-cli.js" (
  echo 缺少程序文件\dist\link-cli.js，请先运行 npm run build。
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%程序文件\link-window.ps1" -ProjectRoot "%PROJECT_ROOT%"
if errorlevel 1 (
  echo 链接资料库未能启动。请检查 Node.js、程序构建和 logs\link-window.log。
  pause
)
endlocal

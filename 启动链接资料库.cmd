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
start "" powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%PROJECT_ROOT%程序文件\link-window.ps1"
if errorlevel 1 (
  echo 无法创建链接资料库窗口进程，请检查 Windows PowerShell 是否可用。
  pause
)
endlocal

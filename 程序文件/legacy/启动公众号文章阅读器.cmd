@echo off
chcp 65001 >nul
setlocal
for %%I in ("%~dp0..\..") do set "WECHAT_READER_PROJECT_ROOT=%%~fI"
set "WECHAT_READER_SCRIPT=%~dp0..\reader-window.ps1"
if not exist "%WECHAT_READER_SCRIPT%" (
  echo 缺少程序文件\reader-window.ps1，请检查项目文件是否完整。
  pause
  exit /b 1
)
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -Command "try { $ErrorActionPreference = 'Stop'; & $env:WECHAT_READER_SCRIPT -ProjectRoot $env:WECHAT_READER_PROJECT_ROOT } catch { Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Reader startup error') }"
endlocal

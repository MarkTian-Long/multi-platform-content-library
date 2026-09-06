@echo off
setlocal
set "WECHAT_READER_LAUNCH_ROOT=%~dp0"
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -Command "try { $ErrorActionPreference = 'Stop'; $script = Get-ChildItem -LiteralPath $env:WECHAT_READER_LAUNCH_ROOT -Directory | ForEach-Object { Join-Path $_.FullName 'reader-window.ps1' } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1; if (-not $script) { throw 'reader-window.ps1 was not found.' }; & $script -ProjectRoot $env:WECHAT_READER_LAUNCH_ROOT } catch { Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Reader startup error') }"
endlocal

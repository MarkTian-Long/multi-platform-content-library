@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$script = Get-ChildItem -Path '%~dp0*\reader-window.ps1' | Select-Object -First 1 -ExpandProperty FullName; if ($script) { & $script -ProjectRoot '%~dp0' }"

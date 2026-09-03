@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0程序文件\reader-window.ps1" -ProjectRoot "%~dp0"

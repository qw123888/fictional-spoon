@echo off
chcp 65001 >nul
title 电话通知站 - 推送到 GitHub
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0push-github.ps1" %*
echo.
pause

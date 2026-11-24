@echo off
setlocal
chcp 65001 >nul
title 绘遇 HUIYU · 桌面部署
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\maintenance\deploy-desktop-quick.ps1" %*
set "DEPLOY_EXIT=%ERRORLEVEL%"
echo.
if not defined AICS_WORKFLOW_NONINTERACTIVE (
  echo 按任意键关闭窗口...
  pause >nul
)
exit /b %DEPLOY_EXIT%

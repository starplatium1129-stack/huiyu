@echo off
chcp 65001 >nul
echo === 绘遇桌面部署 ===
echo 自动选择匹配构建或升级包，需要提权时请确认 UAC。
echo 参数说明: docs\desktop-deployment.md
echo 部署进度: runtime\desktop-deploy-last.log
echo 构建详情: runtime\desktop-deploy-build.log
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\maintenance\deploy-desktop-quick.ps1" %*
set "DEPLOY_EXIT=%ERRORLEVEL%"
echo.
echo === 部署结束，退出码=%DEPLOY_EXIT% ===
if not defined AICS_WORKFLOW_NONINTERACTIVE pause
exit /b %DEPLOY_EXIT%

@echo off
chcp 65001 >nul
echo === AI-CG-Studio 桌面端部署 ===
echo.
echo 默认：增量部署（清理历史残留 + 复制最新代码 + 清缓存 + 验证反推依赖 + 重启）
echo.
echo 可选参数（可直接追加在本文件名后面）：
echo   -SkipBuild 跳过前端构建      -Cleanup 清理历史残留（默认已带）
echo   -UseInstaller 用完整安装包   -NoRestart 部署后不启动
echo   -QuietInstall 完整安装时自动执行，仅需确认 UAC
echo   -StartupRepair 修复 1.6.0 缺失文档与旧图标，不改用户数据
echo   -InstallDir 指定安装目录，默认读取已安装位置
echo   -InstallerPath 指定已验收的安装包，与 -UseInstaller 一起使用
echo.
echo 例：deploy-desktop.bat -UseInstaller -NoRestart
echo.
echo 若弹出 UAC 窗口，请点「是」。
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\maintenance\deploy-desktop-quick.ps1" -Cleanup %*
set "DEPLOY_EXIT=%ERRORLEVEL%"
echo.
echo === 结束（exit=%DEPLOY_EXIT%），请查看提权窗口的输出 ===
if not defined AICS_WORKFLOW_NONINTERACTIVE pause
exit /b %DEPLOY_EXIT%

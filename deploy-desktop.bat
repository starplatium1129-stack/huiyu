@echo off
chcp 65001 >nul
echo === HUIYU desktop deployment ===
echo.
echo Default: incremental resource sync, cache refresh and restart.
echo.
echo Options:
echo   -SkipBuild Skip build    -Cleanup Remove obsolete resources
echo   -UseInstaller Full installation    -NoRestart Leave app closed
echo   -QuietInstall Silent installer after Windows UAC consent
echo   -StartupRepair Repair startup resources and shortcuts
echo   -InstallDir Select the installed application directory
echo   -InstallerPath Select an exact verified setup EXE with -UseInstaller
echo.
echo Example: deploy-desktop.bat -UseInstaller -NoRestart
echo.
echo Confirm the Windows UAC prompt when requested.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\maintenance\deploy-desktop-quick.ps1" -Cleanup %*
set "DEPLOY_EXIT=%ERRORLEVEL%"
echo.
echo === Finished - exit=%DEPLOY_EXIT% ===
if not defined AICS_WORKFLOW_NONINTERACTIVE pause
exit /b %DEPLOY_EXIT%

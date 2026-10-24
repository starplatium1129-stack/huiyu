@echo off
chcp 65001 >nul
echo === HUIYU desktop deployment ===
echo.
echo Default: inspect installed state, then choose no-op/resources/upgrade/package/rebuild.
echo Just run this file. Installation is silent after UAC; retired resources are cleaned automatically.
echo.
echo Options:
echo   -SkipBuild Reuse native build    -Cleanup Remove obsolete resources
echo   -ForceBuild Rebuild instead of automatic reuse
echo   -UseInstaller Reuse existing upgrade    -NoRestart Leave app closed
echo   -ResourcesOnly Sync static resources with matching EXE/DLL only
echo   -QuietInstall Silent installer after Windows UAC consent
echo   -StartupRepair Repair startup resources and shortcuts
echo   -InstallDir Select the installed application directory
echo   -InstallerPath Select an exact bound EXE with -UseInstaller
echo                  Fresh/repair auto-uses the current full package if present;
echo                  keep its .deployment.json beside runtime\desktop-updates or Downloads.
echo.
echo Daily use: deploy-desktop.bat
echo Advanced overrides below are optional; no suffix is needed for daily deployment.
echo.
echo Confirm the Windows UAC prompt when requested.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\maintenance\deploy-desktop-quick.ps1" %*
set "DEPLOY_EXIT=%ERRORLEVEL%"
echo.
echo === Finished - exit=%DEPLOY_EXIT% ===
if not defined AICS_WORKFLOW_NONINTERACTIVE pause
exit /b %DEPLOY_EXIT%

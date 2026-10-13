@echo off
chcp 65001 >nul
echo === HUIYU desktop deployment ===
echo.
echo Default: build and install a local upgrade package, then restart.
echo.
echo Options:
echo   -SkipBuild Reuse native build    -Cleanup Remove obsolete resources
echo   -UseInstaller Reuse existing upgrade    -NoRestart Leave app closed
echo   -ResourcesOnly Sync static resources with matching EXE/DLL only
echo   -QuietInstall Silent installer after Windows UAC consent
echo   -StartupRepair Repair startup resources and shortcuts
echo   -InstallDir Select the installed application directory
echo   -InstallerPath Select an exact bound EXE with -UseInstaller
echo                  Required for a full release installer / fresh install
echo.
echo Example: deploy-desktop.bat -QuietInstall -NoRestart
echo.
echo Confirm the Windows UAC prompt when requested.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\maintenance\deploy-desktop-quick.ps1" -Cleanup %*
set "DEPLOY_EXIT=%ERRORLEVEL%"
echo.
echo === Finished - exit=%DEPLOY_EXIT% ===
if not defined AICS_WORKFLOW_NONINTERACTIVE pause
exit /b %DEPLOY_EXIT%

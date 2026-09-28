# AI-CG-Studio launcher
# Usage: double-click control.bat

$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

Write-Host ""
Write-Host "  AI-CG-Studio" -ForegroundColor Cyan
Write-Host "  ======================================" -ForegroundColor DarkGray
Write-Host ""

# 1. Check Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "  [ERROR] Node.js not found. Install from https://nodejs.org" -ForegroundColor Red
    Read-Host "  Press Enter to exit"
    exit 1
}
Write-Host "  Node.js: $(node --version)" -ForegroundColor DarkGray

# 2. Install deps
if (-not (Test-Path "node_modules")) {
    Write-Host "  Installing dependencies..." -ForegroundColor Yellow
    npm ci
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [ERROR] npm ci failed" -ForegroundColor Red
        Read-Host "  Press Enter to exit"
        exit 1
    }
}

# 3. Build SPA if needed
if (-not (Test-Path "dist\index.html")) {
    Write-Host "  Building Vue SPA..." -ForegroundColor Yellow
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [ERROR] Build failed" -ForegroundColor Red
        Read-Host "  Press Enter to exit"
        exit 1
    }
}

# Compile development commands from the current checkout (cached when unchanged).
Write-Host "  Preparing development commands..." -ForegroundColor Yellow
npm run build:runtime
if ($LASTEXITCODE -ne 0) { Write-Error 'Development command build failed'; exit 1 }
# 3c. git bundle 异地快照（尽力而为，失败不阻断启动；2026-08-29 审计 P0-2，详见红线 5/9）
Write-Host "  git bundle backup..." -ForegroundColor DarkGray
node scripts/maintenance/git-bundle-backup.js

# Never kill an unknown process or bypass a workspace writer's normal drain.
$existing = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host '  [ERROR] Port 3000 is occupied. Stop the owning application normally before starting another runtime.' -ForegroundColor Red
    Read-Host '  Press Enter to exit'
    exit 1
}
# 5. Open browser after delay (cmd /c avoids PS job issues)
cmd /c "start /min cmd /c timeout /t 2 /nobreak >nul ^&^& start http://127.0.0.1:3000/control" 2>$null

# 6. Start server
Write-Host "  Control panel : http://127.0.0.1:3000/control" -ForegroundColor Green
Write-Host "  Local site    : http://127.0.0.1:3000/" -ForegroundColor Green
Write-Host "  Press Ctrl+C to stop" -ForegroundColor DarkGray
Write-Host ""

node scripts/maintenance/run-rust-runtime.js start

Write-Host ""
Write-Host "  Server stopped." -ForegroundColor DarkGray
Read-Host "  Press Enter to close"

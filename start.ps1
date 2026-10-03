# AI-CG-Studio launcher
# Usage: double-click control.bat

$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

$logDirectory = Join-Path $PSScriptRoot 'runtime\logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$startupLog = Join-Path $logDirectory ("startup-{0}-{1}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $PID)
Set-Content -LiteralPath $startupLog -Value 'AI-CG-Studio startup' -Encoding UTF8

function Invoke-Preparation([string]$label, [scriptblock]$command) {
    Write-Host "  $label..." -ForegroundColor Yellow
    Add-Content -LiteralPath $startupLog -Value "--- $label ---" -Encoding UTF8
    & $command 2>&1 | ForEach-Object { Add-Content -LiteralPath $startupLog -Value $_.ToString() -Encoding UTF8 }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [ERROR] $label failed. Details: $startupLog" -ForegroundColor Red
        Get-Content -LiteralPath $startupLog -Tail 12 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkRed }
        Read-Host '  Press Enter to exit'
        exit 1
    }
}

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
node --version | ForEach-Object { Add-Content -LiteralPath $startupLog -Value "Node.js: $_" -Encoding UTF8 }

# 2. Install deps
if (-not (Test-Path "node_modules")) {
    Invoke-Preparation 'Installing dependencies' { npm ci }
}

# 3. Build SPA if needed
if (-not (Test-Path "dist\index.html")) {
    Invoke-Preparation 'Building Vue SPA' { npm run build }
}

# Compile development commands from the current checkout (cached when unchanged).
Invoke-Preparation 'Development command build' { npm run build:runtime }
# 3c. git bundle 异地快照（尽力而为，失败不阻断启动；2026-08-29 审计 P0-2，详见红线 5/9）
node scripts/maintenance/git-bundle-backup.js 2>&1 | ForEach-Object { Add-Content -LiteralPath $startupLog -Value $_.ToString() -Encoding UTF8 }
if ($LASTEXITCODE -ne 0) { Write-Host "  [WARN] Git backup was not completed; startup continues. Details: $startupLog" -ForegroundColor Yellow }

# Never kill an unknown process or bypass a workspace writer's normal drain.
$port = if ($env:PORT) { $env:PORT } else { 3000 }
$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "  [ERROR] Port $port is occupied. Stop the owning application normally before starting another runtime." -ForegroundColor Red
    Read-Host '  Press Enter to exit'
    exit 1
}
# 5. Start server; Cargo may need to compile before the gateway can listen.
Write-Host '  Starting Rust gateway; the browser will open when it is ready...' -ForegroundColor Yellow

$browserOpened = $false
node scripts/maintenance/run-rust-runtime.js start 2>&1 | ForEach-Object {
    $isError = $_ -is [System.Management.Automation.ErrorRecord]
    foreach ($line in ($_.ToString() -split '\r?\n')) {
        Add-Content -LiteralPath $startupLog -Value $line -Encoding UTF8
        $plainLine = $line -replace '\x1b\[[0-9;]*m', ''
        $cargoProgress = $plainLine -match '^\s{2,}(?:Compiling\s+\S+\s+v\d|Finished\s+.+target\(s\)|Running\s+`)'
        if ($isError -and -not $cargoProgress -and $plainLine -and $plainLine -ne 'System.Management.Automation.RemoteException') {
            Write-Host "  $line" -ForegroundColor Yellow
        }
        if (-not $isError -and -not $browserOpened -and $line -match '^\s*\{') {
            try { $ready = $line | ConvertFrom-Json -ErrorAction Stop }
            catch { $ready = $null }
            if ($ready.event -eq 'ready' -and $ready.runtime -eq 'rust' -and
                $ready.origin -match '^http://(?:127\.0\.0\.1|\[::1\]|0\.0\.0\.0|\[::\]):(\d+)$') {
                $controlUrl = "http://127.0.0.1:$($Matches[1])/control"
                if ($ready.origin -match '^http://\[::') {
                    $controlUrl = "http://[::1]:$(([Uri]$ready.origin).Port)/control"
                }
                $browserOpened = $true
                Write-Host "  Control panel ready: $controlUrl" -ForegroundColor Green
                Write-Host "  Log: $startupLog" -ForegroundColor DarkGray
                Write-Host '  Press Ctrl+C to stop' -ForegroundColor DarkGray
                try { Start-Process $controlUrl -ErrorAction Stop }
                catch { Write-Warning "Could not open the browser. Open $controlUrl manually. $_" }
            }
        }
    }
}
$serverExitCode = $LASTEXITCODE

Write-Host ""
if ($serverExitCode -ne 0) {
    Write-Host "  [ERROR] Server exited with code $serverExitCode. Details: $startupLog" -ForegroundColor Red
} else {
    Write-Host "  Server stopped." -ForegroundColor DarkGray
}
Read-Host "  Press Enter to close"
exit $serverExitCode

# AI-CG-Studio local ComfyUI launcher.
# Current setup and model guide: docs/guides/setup-and-models.md.
# Report installed versions at launch; do not claim an old dependency combination is active.
# This command starts only one local instance and preserves the installed model environment.

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$workspaceRoot = if ($env:AI_WORKSPACE_ROOT) { $env:AI_WORKSPACE_ROOT } else { Join-Path $projectRoot '..\AI' }
$comfyRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'ComfyUI'))
$python = Join-Path $comfyRoot 'venv\Scripts\python.exe'
$logDir = Join-Path $comfyRoot 'user'

if (-not (Test-Path $python)) {
  Write-Host "venv python not found: $python"
  exit 1
}

# Do not start a second instance while one is healthy.
$existing = Get-NetTCPConnection -LocalPort 8188 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "ComfyUI already listening on 8188 (pid $($existing.OwningProcess)) - nothing to do."
  exit 0
}

Write-Host 'Starting local ComfyUI with the installed environment...'
& $python -c "import importlib.metadata as m; print('torch=' + m.version('torch') + ' comfy-aimdo=' + m.version('comfy-aimdo'))"
$out = Join-Path $logDir 'comfyui-run.log'
$err = Join-Path $logDir 'comfyui-run.err.log'
Start-Process -FilePath $python -ArgumentList @(
  '-u',
  (Join-Path $comfyRoot 'main.py'),
  '--listen', '127.0.0.1',
  '--port', '8188',
  '--use-sage-attention',
  '--fast-disk',
  '--vram-headroom', '1'
) -WorkingDirectory $comfyRoot -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden

Write-Host 'Waiting for health check...'
$deadline = (Get-Date).AddSeconds(90)
do {
  Start-Sleep -Seconds 2
  $listener = Get-NetTCPConnection -LocalPort 8188 -State Listen -ErrorAction SilentlyContinue
} while (-not $listener -and (Get-Date) -lt $deadline)

if (-not $listener) {
  Write-Host 'ComfyUI failed to start - see logs below:'
  Get-Content $err -Tail 20 -ErrorAction SilentlyContinue
  exit 1
}
Write-Host "ComfyUI is up (pid $($listener.OwningProcess)) at http://127.0.0.1:8188"

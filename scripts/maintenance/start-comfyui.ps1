# AI-CG-Studio local ComfyUI launcher.
# Current setup and model guide: docs/guides/setup-and-models.md.
# Report installed versions at launch; do not claim an old dependency combination is active.
# This command starts only one local instance and preserves the installed model environment.

param([switch]$UseSageAttention = ($env:AICS_COMFY_USE_SAGE_ATTENTION -ne '0'))

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$workspaceRoot = if ($env:AI_WORKSPACE_ROOT) { $env:AI_WORKSPACE_ROOT } else { Join-Path $projectRoot '..\AI' }
$comfyRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'ComfyUI'))
$python = Join-Path $comfyRoot 'venv\Scripts\python.exe'
$mainPath = Join-Path $comfyRoot 'main.py'
$logDir = Join-Path $comfyRoot 'user'

if (-not (Test-Path -LiteralPath $python -PathType Leaf) -or -not (Test-Path -LiteralPath $mainPath -PathType Leaf)) {
  Write-Host "Managed startup requires ComfyUI/main.py and ComfyUI/venv/Scripts/python.exe under the AI workspace: $comfyRoot"
  exit 1
}

# Do not start a second instance while one is healthy.
$existing = Get-NetTCPConnection -LocalPort 8188 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "ComfyUI already listening on 8188 (pid $($existing.OwningProcess)) - nothing to do."
  exit 0
}

Write-Host 'Starting local ComfyUI with the installed environment...'
& $python -c "import importlib.metadata as m; print('torch=' + m.version('torch'))"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$out = Join-Path $logDir 'comfyui-run.log'
$err = Join-Path $logDir 'comfyui-run.err.log'
$arguments = @(
  '-u',
  ('"{0}"' -f $mainPath),
  '--listen', '127.0.0.1',
  '--port', '8188',
  '--fast-disk',
  '--vram-headroom', '1'
)
# Prefer installed SageAttention on CUDA; explicit 0 keeps PyTorch attention.
if ($UseSageAttention) {
  $sageAvailable = & $python -c "import importlib.util, torch; print(int(torch.cuda.is_available() and importlib.util.find_spec('sageattention') is not None))"
  if ($sageAvailable -eq '1') { $arguments += '--use-sage-attention' }
  else { Write-Host 'SageAttention or CUDA is unavailable; using PyTorch attention.' }
}
Start-Process -FilePath $python -ArgumentList $arguments -WorkingDirectory $comfyRoot -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden

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

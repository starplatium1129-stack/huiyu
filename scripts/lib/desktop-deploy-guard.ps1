# Read-only preflight. Closing a Tauri window hides it; only the application's
# normal Quit action drains its runtime and releases the workspace owner.
function Assert-DesktopDeploymentStopped {
  param([Parameter(Mandatory=$true)][string]$InstallDir,
        [Parameter(Mandatory=$true)][string]$ConfigRoot)

  $installRoot = [IO.Path]::GetFullPath($InstallDir)
  $executables = @((Join-Path $installRoot 'ai-cg-studio-desktop.exe'), (Join-Path $installRoot 'node.exe'))
  $running = @(Get-Process -Name 'ai-cg-studio-desktop','node' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $executables -contains $_.Path })
  if ($running.Count -gt 0) {
    throw 'DESKTOP_RUNNING: 请从托盘选择“退出 Companion”，等待网关退出后重新部署；隐藏窗口不等于退出。此次未停止任何进程。'
  }

  foreach ($name in @('workspace-active.json', 'workspace-candidate.json')) {
    $pointerPath = Join-Path $ConfigRoot $name
    if (-not (Test-Path -LiteralPath $pointerPath)) { continue }
    $pointer = Get-Content -LiteralPath $pointerPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $workspaceId = $pointer.workspaceId
    if ($workspaceId -isnot [string] -or $workspaceId -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$') {
      throw "WORKSPACE_POINTER_INVALID: $name 的工作区身份无效，部署已停止。"
    }
    $owner = Join-Path (Join-Path (Join-Path $ConfigRoot 'workspaces') $workspaceId) '.workspace-owner.json'
    if (Test-Path -LiteralPath $owner) {
      throw "WORKSPACE_LOCK_REMAINS: 工作区 $workspaceId 仍有 owner 锁，请先完成退出或维修。锁和资料均未修改。"
    }
  }
}

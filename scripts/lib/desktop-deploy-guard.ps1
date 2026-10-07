# Controlled host maintenance plus read-only verification. The host owns flush,
# drain and child teardown; this script never kills processes or removes locks.
function Get-DesktopInstallationProcesses {
  param([string]$InstallDir)
  $executables = @((Join-Path $InstallDir 'ai-cg-studio-desktop.exe'), (Join-Path $InstallDir 'gateway\huiyu-runtime.exe'))
  @(Get-Process -Name 'ai-cg-studio-desktop','huiyu-runtime' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $executables -contains $_.Path })
}

function Get-DesktopMaintenanceIdentity {
  param([string]$InstallDir, [string]$ConfigRoot)
  $capability = Join-Path $ConfigRoot 'desktop-maintenance.json'
  if (-not (Test-Path -LiteralPath $capability)) {
    throw 'DESKTOP_MAINTENANCE_UNSUPPORTED: 此运行版本未提供受控维护退出；请从托盘正常退出后重试。未调用未知CLI或停止任何进程。'
  }
  $file = Get-Item -LiteralPath $capability
  if ($file.Length -gt 4096 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'DESKTOP_MAINTENANCE_IDENTITY: 能力描述无效。' }
  $identity = Get-Content -LiteralPath $capability -Raw -Encoding UTF8 | ConvertFrom-Json
  $expected = Join-Path ([IO.Path]::GetFullPath($InstallDir)) 'ai-cg-studio-desktop.exe'
  if ($identity.protocolVersion -ne 1 -or $identity.instanceId -notmatch '^[a-f0-9]{64}$' -or
      ($identity.hostPid -isnot [int] -and $identity.hostPid -isnot [long]) -or
      $identity.hostPid -le 0 -or $identity.hostPid -gt [int]::MaxValue -or $identity.executable -ine $expected -or
      $identity.startedAtFiletime -notmatch '^\d{16,20}$' -or
      $identity.instanceNamespace -notmatch '^com\.aics\.studio(?:\.maintenance\.[a-f0-9]{64})?$') { throw 'DESKTOP_MAINTENANCE_IDENTITY: 能力描述与本次安装不匹配。' }
  $hostProcess = Get-Process -Id $identity.hostPid -ErrorAction SilentlyContinue
  if (-not $hostProcess -or $hostProcess.Path -ine $expected -or
      $hostProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $identity.startedAtFiletime) {
    throw 'DESKTOP_MAINTENANCE_IDENTITY: 运行实例已变化；未向未知进程发送请求。'
  }
  $identity
}

function Invoke-DesktopMaintenance {
  param([Parameter(Mandatory=$true)][string]$InstallDir,
        [Parameter(Mandatory=$true)][string]$ConfigRoot,
        [ValidateSet('status','shutdown')][string]$Command,
        [int]$TimeoutSeconds = 75)
  $identity = Get-DesktopMaintenanceIdentity -InstallDir $InstallDir -ConfigRoot $ConfigRoot
  $directory = Join-Path $ConfigRoot 'desktop-maintenance'
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  if ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'DESKTOP_MAINTENANCE_PATH: 请求目录不能是重解析路径。' }
  $requestId = [Guid]::NewGuid().ToString('N')
  $requestPath = Join-Path $directory "$requestId.request.json"
  $responsePath = Join-Path $directory "$requestId.response.json"
  $request = @{requestId=$requestId;instanceId=$identity.instanceId;hostPid=$identity.hostPid;command=$Command} | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($requestPath, $request, (New-Object Text.UTF8Encoding($false)))
  try {
    $client = Start-Process -FilePath $identity.executable -ArgumentList @('--desktop-maintenance',$Command,'--maintenance-request',$requestId,'--maintenance-namespace',$identity.instanceNamespace) -WindowStyle Hidden -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
      if (Test-Path -LiteralPath $responsePath) {
        $responseFile = Get-Item -LiteralPath $responsePath
        if ($responseFile.Length -gt 4096 -or ($responseFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'DESKTOP_MAINTENANCE_RECEIPT: 回执体积或文件类型无效。' }
        $receipt = Get-Content -LiteralPath $responsePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($receipt.requestId -ne $requestId -or $receipt.instanceId -ne $identity.instanceId -or
            $receipt.hostPid -ne $identity.hostPid -or $receipt.startedAtFiletime -ne $identity.startedAtFiletime -or
            $receipt.instanceNamespace -ne $identity.instanceNamespace -or
            $receipt.executable -ine $identity.executable -or $receipt.protocolVersion -ne 1) { throw 'DESKTOP_MAINTENANCE_RECEIPT: 回执身份不匹配。' }
        return $receipt
      }
      if ($client.HasExited -and $client.ExitCode -ne 0) { throw "DESKTOP_MAINTENANCE_CLIENT: 请求进程退出 $($client.ExitCode)，部署已停止。" }
      Start-Sleep -Milliseconds 100
    }
    throw 'DESKTOP_MAINTENANCE_TIMEOUT: 无法确认受控退出；安装未开始，进程与锁均未强制清理。'
  } finally {
    foreach ($ownedRequestFile in @($requestPath, $responsePath)) {
      if (Test-Path -LiteralPath $ownedRequestFile) { Remove-Item -LiteralPath $ownedRequestFile -Force }
    }
  }
}

function Stop-DesktopForDeployment {
  param([string]$InstallDir, [string]$ConfigRoot)
  if (@(Get-DesktopInstallationProcesses -InstallDir $InstallDir).Count -gt 0) {
    $receipt = Invoke-DesktopMaintenance -InstallDir $InstallDir -ConfigRoot $ConfigRoot -Command shutdown
    if ($receipt.state -ne 'drained') { throw "DESKTOP_MAINTENANCE_REFUSED: $($receipt.state) / $($receipt.reason)。安装未开始。" }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (@(Get-DesktopInstallationProcesses -InstallDir $InstallDir).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
  }
  Assert-DesktopDeploymentStopped -InstallDir $InstallDir -ConfigRoot $ConfigRoot
}

function Wait-DesktopDeploymentReady {
  param([string]$InstallDir, [string]$ConfigRoot, [int]$TimeoutSeconds = 60)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastFailure = 'DESKTOP_STARTING'
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $status = Invoke-DesktopMaintenance -InstallDir $InstallDir -ConfigRoot $ConfigRoot -Command status -TimeoutSeconds 5
      if ($status.state -eq 'ready') { return $status }
      if ($status.state -eq 'blocked') { throw 'DESKTOP_MAINTENANCE_BLOCKED' }
      $lastFailure = [string]$status.state
    } catch { $lastFailure = $_.Exception.Message }
    Start-Sleep -Milliseconds 500
  }
  throw "DESKTOP_STARTUP_UNCONFIRMED: $lastFailure。安装已完成，但启动未获身份验证；未停止应用或删除资料。"
}

function Assert-DesktopDeploymentStopped {
  param([Parameter(Mandatory=$true)][string]$InstallDir,
        [Parameter(Mandatory=$true)][string]$ConfigRoot)

  $installRoot = [IO.Path]::GetFullPath($InstallDir)
  $running = @(Get-DesktopInstallationProcesses -InstallDir $installRoot)
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

# A resource refresh cannot replace executable/runtime dependencies. Both sides
# must be plain files in their explicit roots; missing Rust layouts need install.
function Resolve-DesktopChildPath {
  param([string]$Root, [string]$Relative)
  $base = [IO.Path]::GetFullPath($Root).TrimEnd('\','/')
  $target = [IO.Path]::GetFullPath((Join-Path $base $Relative))
  if (-not $target.StartsWith($base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'DESKTOP_PATH_ESCAPE' }
  $current = $base
  foreach ($part in @('') + $Relative.Split([char[]]'\/')) {
    if ($part) { $current = Join-Path $current $part }
    if (Test-Path -LiteralPath $current) {
      if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'DESKTOP_LINK_UNSUPPORTED' }
    }
  }
  return $target
}
# Windows PowerShell may inherit a pwsh-only PSModulePath. Hash through .NET so
# dependency verification never relies on module discovery or weaker fallbacks.
function Get-DesktopFileSha256 {
  param([string]$Path)
  $stream = [IO.File]::OpenRead($Path)
  try {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
    finally { $algorithm.Dispose() }
  } finally { $stream.Dispose() }
}

# Tauri 2.12 stamps the NSIS copy with NSS, then restores the build EXE to UNK.
# Derive that single documented transformation from the bound source bytes;
# the installed image still has to match its full SHA-256, with no other edits.
# Retire this derivation when the build receipt binds the packaged host directly.
# https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.0/crates/tauri-bundler/src/bundle.rs
function Get-DesktopNsisHostSha256 {
  param([string]$Path)
  $bytes = [IO.File]::ReadAllBytes($Path)
  $marker = '__TAURI_BUNDLE_TYPE_VAR_UNK'
  $text = [Text.Encoding]::ASCII.GetString($bytes)
  $offset = $text.IndexOf($marker, [StringComparison]::Ordinal)
  if ($offset -lt 0 -or $text.IndexOf($marker, $offset + $marker.Length, [StringComparison]::Ordinal) -ge 0) {
    throw 'DESKTOP_BUNDLE_MARKER_INVALID: Expected one unpatched Tauri bundle marker; rebuild with the verified NSIS toolchain.'
  }
  $replacement = [Text.Encoding]::ASCII.GetBytes('__TAURI_BUNDLE_TYPE_VAR_NSS')
  [Buffer]::BlockCopy($replacement, 0, $bytes, $offset, $replacement.Length)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($bytes)).Replace('-', '') }
  finally { $algorithm.Dispose() }
}

function Assert-DesktopRuntimeMatches {
  param([string]$StageGateway, [string]$InstallDir, [string]$HostExecutable)
  $pairs = @(
    @{ Source = $HostExecutable; Target = (Resolve-DesktopChildPath $InstallDir 'ai-cg-studio-desktop.exe'); NsisHost = $true },
    @{ Source = (Resolve-DesktopChildPath $StageGateway 'huiyu-runtime.exe'); Target = (Resolve-DesktopChildPath $InstallDir 'gateway\huiyu-runtime.exe') },
    @{ Source = (Resolve-DesktopChildPath $StageGateway 'native\libvips-42.dll'); Target = (Resolve-DesktopChildPath $InstallDir 'gateway\native\libvips-42.dll') }
  )
  foreach ($pair in $pairs) {
    if (-not (Test-Path -LiteralPath $pair.Source -PathType Leaf) -or -not (Test-Path -LiteralPath $pair.Target -PathType Leaf)) { throw 'DESKTOP_FULL_INSTALL_REQUIRED: Rust runtime/native dependency missing; use -UseInstaller.' }
    if ((Get-Item -LiteralPath $pair.Source).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'DESKTOP_LINK_UNSUPPORTED' }
    $expected = if ($pair.NsisHost) { Get-DesktopNsisHostSha256 -Path $pair.Source } else { Get-DesktopFileSha256 -Path $pair.Source }
    if ($expected -ne (Get-DesktopFileSha256 -Path $pair.Target)) { throw 'DESKTOP_FULL_INSTALL_REQUIRED: executable or DLL differs; use -UseInstaller.' }
  }
}

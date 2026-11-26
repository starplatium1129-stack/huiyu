# AI-CG-Studio 桌面端部署 —— 唯一入口
#
# 默认启动后先检测安装状态、已安装文件和源码/构建/升级包绑定，再自动选择：
# 已登记同版本开发安装默认按绑定清单直写；首次安装、版本升级及修复使用安装包。
# -ResourcesOnly 仅同步已绑定静态资源，要求安装 EXE/DLL 与候选一致。
# -UseInstaller 复用已绑定安装包；显式指定 -InstallerPath 可覆盖自动选择。
#
# 常用组合：
#   双击 deploy-desktop.bat                 自动检测并选择最合适的部署方式
#   deploy-desktop.bat -SkipBuild           复用已绑定的构建并直写差异
#   deploy-desktop.bat -UseInstaller        安装已有升级包
#   deploy-desktop.bat -NoRestart           部署后不自动启动
#
# 参数说明：
#   -SkipBuild     复用匹配当前源码的桌面构建绑定
#   -Cleanup       兼容旧调用；清理由资源清单自动控制
#   -UseInstaller  跑已有安装包，不重新构建或封装
#   -ResourcesOnly 只同步静态资源
#   -ReferenceIds 同步指定角色的个人参考分片（逗号分隔）
#   -NoRestart     结束后不启动桌面端
param(
  [switch]$SyncLocalModels,
  [switch]$SkipBuild,
  [switch]$ForceBuild,
  [switch]$Cleanup,
  [switch]$UseInstaller,
  [switch]$ResourcesOnly,
  [switch]$QuietInstall,
  [switch]$NoRestart,
  [switch]$StartupRepair,
  [switch]$AdoptProjectCatalog,
  [string]$ReferenceIds,
  # 内部使用：提权子进程完成安装后交由非提权父进程启动，避免跨桌面维护握手。
  [switch]$DeferRestart,
  # 内部使用：父进程已在 UAC 前完成检测并选定模式，子进程不再重复检测。
  [switch]$DeploymentPlanApplied,
  [switch]$DirectInstall,
  [string]$DirectPlanId,
  [string]$DirectPlanSha256,
  [string]$DeploymentLogId,
  [string]$InstallDir,
  [string]$InstallerPath,
  [string]$InstallerManifestSha256,
  # 内部使用：保留发起部署的用户目录（UAC 可能使用另一管理员账户）。
  [string]$OriginalAppData,
  [string]$OriginalLocalAppData,
  [string]$OriginalDesktop,
  [string]$OriginalPrograms
)

$ErrorActionPreference = 'Stop'
if ($StartupRepair -and $ResourcesOnly) {
  throw '-StartupRepair 与 -ResourcesOnly 不能同时使用。'
}
$utf8NoBom = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom
try { [Console]::InputEncoding = $utf8NoBom } catch { }
$OutputEncoding = $utf8NoBom
$script:overallTimer = [Diagnostics.Stopwatch]::StartNew()
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $DeploymentLogId) { $DeploymentLogId = [Guid]::NewGuid().ToString('N') }
if ($DeploymentLogId -cnotmatch '^[a-f0-9]{32}$') { throw '无效的部署日志编号' }
$logRelative = "runtime\desktop-deploy-logs\$DeploymentLogId.log"
$deploymentLogPath = Join-Path $root $logRelative
. (Join-Path $root 'scripts\lib\desktop-deploy-context.ps1')

try {
$lockPath = Resolve-DesktopChildPath -Root $root -Relative 'runtime\desktop-deploy.lock'
if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
  try {
    [IO.File]::Open($lockPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite).Dispose()
  } catch [IO.IOException] {
    $win32Code = $_.Exception.GetBaseException().HResult -band 0xffff
    if ($win32Code -in @(32,33)) {
      Write-DeploymentLog 'DESKTOP_DEPLOY_BUSY: 当前工作区已有部署。'
      if (-not $DeferRestart) {
        Write-DesktopSummary -Kind 'busy' -Title '当前工作区已有另一个部署任务正在执行' -Details @('请等待上一个部署窗口完成后再重试。')
      }
      exit 73
    }
    if ($win32Code -notin @(2,3)) { throw }
  }
}
$moduleExitCode = $null
. (Join-Path $root 'scripts\lib\desktop-deploy-plan.ps1')
if ($null -ne $moduleExitCode) { exit $moduleExitCode }

# Preflight notice: UAC denial, missing payload or build failure leaves the
# running app untouched. Actual automatic shutdown runs right before writes.
if (@(Get-DesktopInstallationProcesses -InstallDir $installDir).Count -gt 0) {
  Write-Host '  · 检测到桌面端正在运行，授权后将在写入前自动关闭并在部署完成后重启。' -ForegroundColor DarkGray
}

# 提权：注意要把已传入的参数一起带过去，否则 UAC 后的新进程会丢掉它们
# （旧版这里只传脚本路径，导致 -SkipBuild 静默失效、白白重跑一次 build）。
if (-not $isElevated) {
  Write-Host '  ! 写入安装目录需要管理员权限，请在弹出的 UAC 窗口中点击“是”...' -ForegroundColor Yellow
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  if ($SkipBuild)    { $argList += '-SkipBuild' }
  if ($ForceBuild)   { $argList += '-ForceBuild' }
  if ($Cleanup)      { $argList += '-Cleanup' }
  if ($UseInstaller) { $argList += '-UseInstaller' }
  if ($ResourcesOnly) { $argList += '-ResourcesOnly' }
  if ($InstallerPath) { $argList += @('-InstallerPath', "`"$InstallerPath`"") }
  if ($InstallerManifestSha256) { $argList += @('-InstallerManifestSha256', $InstallerManifestSha256) }
  if ($QuietInstall) { $argList += '-QuietInstall' }
  if ($NoRestart)    { $argList += '-NoRestart' }
  if ($StartupRepair) { $argList += '-StartupRepair' }
  if ($AdoptProjectCatalog) { $argList += '-AdoptProjectCatalog' }
  if ($SyncLocalModels) { $argList += '-SyncLocalModels' }
  if ($ReferenceIds) { $argList += @('-ReferenceIds', $ReferenceIds) }
  if ($DeploymentPlanApplied) { $argList += '-DeploymentPlanApplied' }
  if ($DirectInstall) { $argList += '-DirectInstall' }
  if ($DirectPlanId) { $argList += @('-DirectPlanId', $DirectPlanId, '-DirectPlanSha256', $DirectPlanSha256) }
  $argList += @('-DeploymentLogId', $DeploymentLogId)
  # The elevated process must not launch the desktop client: its window station
  # may differ from the interactive one, making the maintenance handshake fail.
  # It installs and exits; this non-elevated parent starts the client afterwards.
  $argList += '-DeferRestart'
  $argList += @('-OriginalAppData', "`"$profileAppData`"", '-OriginalLocalAppData', "`"$profileLocalAppData`"")
  if ($profileDesktop) { $argList += @('-OriginalDesktop', "`"$profileDesktop`"") }
  if ($profilePrograms) { $argList += @('-OriginalPrograms', "`"$profilePrograms`"") }
  $argList += @('-InstallDir', "`"$installDir`"")
  # Start-Process -Wait includes descendants, so the restarted client would
  # keep this wrapper alive. Wait only for the elevated deployment process.
  $logReader = $null
  $elevatedProcess = $null
  try {
    $logPath = $deploymentLogPath
    if (Test-Path -LiteralPath $logPath) {
      $logStream = [IO.File]::Open($logPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
      $null = $logStream.Seek(0, [IO.SeekOrigin]::End)
      $logReader = New-Object IO.StreamReader($logStream, [Text.Encoding]::UTF8, $true)
    }
    try {
      $elevatedProcess = Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList ($argList -join ' ') -PassThru
    } catch {
      $canceled = $_.Exception.Message -match 'cancel|canceled|cancelled|取消' -or
        ($_.Exception.PSObject.Properties.Name -contains 'NativeErrorCode' -and $_.Exception.NativeErrorCode -eq 1223)
      if ($canceled) {
        Write-DeploymentLog '[desktop:warn] 已取消 UAC 授权（1223），未对安装目录做任何修改。'
        Write-DesktopSummary -Kind 'cancelled' -Title '已取消 UAC 授权，未对安装目录做任何修改' -Details @(
          $(if ($DirectPlanId) { '本次构建已保留，下次双击 deploy-desktop.bat 可直接复用，无需重新编译。' } else { '如需继续部署，请重新运行 deploy-desktop.bat 并允许 UAC 授权。' })
        )
        Remove-DirectDeploymentPlan
        Publish-DeploymentLog
        exit 1223
      }
      throw
    }
    # Retain the handle before exit so Windows PowerShell 5.1 can read ExitCode.
    $null = $elevatedProcess.Handle
    $drainLog = {
      if (-not $logReader -and (Test-Path -LiteralPath $logPath)) {
        $logStream = [IO.File]::Open($logPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        $logReader = New-Object IO.StreamReader($logStream, [Text.Encoding]::UTF8, $true)
      }
      if ($logReader) {
        while ($null -ne ($line = $logReader.ReadLine())) {
          if ($line -match '^\[desktop:|^\[[1-6]/6\]|^DESKTOP_') {
            Write-DesktopRelayLine $line
            if ($line -match '^\[desktop:failed\]\s*(.+)$') { $script:lastElevatedError = $Matches[1] }
          }
        }
      }
    }
    $script:lastElevatedError = ''
    do {
      $finished = $elevatedProcess.WaitForExit(500)
      . $drainLog
    } while (-not $finished)
    Start-Sleep -Milliseconds 100
    . $drainLog
    $deploymentExitCode = $elevatedProcess.ExitCode
    if ($null -eq $deploymentExitCode) { throw 'DESKTOP_DEPLOY_EXITCODE: 无法读取提权部署进程的退出码。' }
  } finally { if ($logReader) { $logReader.Dispose() }; if ($elevatedProcess) { $elevatedProcess.Dispose() } }
  $startedInfo = $null
  if ($deploymentExitCode -eq 0 -and -not $NoRestart) {
    try {
      $startedInfo = Start-DesktopClientAndWait
    } catch {
      $script:lastElevatedError = $_.Exception.Message
      Write-DeploymentLog "[desktop:failed] $($_.Exception.Message)"
      $deploymentExitCode = 1
    }
  }
  if ($deploymentExitCode -ne 73) { Publish-DeploymentLog }
  $elapsedTotal = '{0:F1}s' -f $script:overallTimer.Elapsed.TotalSeconds
  if ($deploymentExitCode -eq 0) {
    $summaryDetails = @("安装目录：$installDir")
    if ($startedInfo) { $summaryDetails += "运行状态：$($startedInfo.visible)（PID $($startedInfo.hostPid)）" }
    elseif ($NoRestart) { $summaryDetails += '已按 -NoRestart 保持桌面端关闭' }
    Write-DesktopSummary -Kind 'success' -Title "绘遇桌面端部署完成（总耗时 $elapsedTotal）" -Details $summaryDetails
  } elseif ($deploymentExitCode -eq 73) {
    Write-DesktopSummary -Kind 'busy' -Title '另一个部署任务占用了工作区或安装目录' -Details @('请等待上一个部署窗口完成后再重试。')
  } else {
    $errLines = @()
    if ($script:lastElevatedError) { $errLines += "原因：$($script:lastElevatedError)" }
    $errLines += "退出码：$deploymentExitCode（总耗时 $elapsedTotal）"
    $errLines += "详细日志：$root\runtime\desktop-deploy-last.log"
    $errLines += "构建日志：$root\runtime\desktop-deploy-build.log"
    Write-DesktopSummary -Kind 'error' -Title '桌面部署未完成' -Details $errLines
  }
  exit $deploymentExitCode
}

$deploymentLock = $null
try {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $lockPath) | Out-Null
  $deploymentLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
} catch [IO.IOException] {
  if (($_.Exception.GetBaseException().HResult -band 0xffff) -notin @(32,33)) { throw }
  Write-DeploymentLog 'DESKTOP_DEPLOY_BUSY: 当前工作区已有部署。'
  Write-Host 'DESKTOP_DEPLOY_BUSY: 当前工作区已有部署。' -ForegroundColor Yellow
  exit 73
}
$transcriptStarted = $false
$installBusy = $false
$installMutex = $null
$installMutexHeld = $false
try {
$moduleExitCode = $null
. (Join-Path $root 'scripts\lib\desktop-deploy-install.ps1')
if ($null -ne $moduleExitCode) { exit $moduleExitCode }
} catch {
  $script:elevatedFailureLogged = $true
  Write-Host "[desktop:failed] $($_.Exception.Message)" -ForegroundColor Red
  if ($installWithPackage -and $InstallerManifestSha256) {
    Write-Host "[desktop:auto] 已固定的安装包仍可复用：$InstallerPath"
    Write-Host '[desktop:auto] 修正上述原因后，可用 -UseInstaller -InstallerPath 指定此包继续，无需重复构建。'
  }
  throw
} finally {
  try {
    if ($transcriptStarted) {
      Stop-Transcript | Out-Null
      if (-not $installBusy) { Publish-DeploymentLog }
    }
  }
  finally {
    if ($installMutex) { if ($installMutexHeld) { $installMutex.ReleaseMutex() }; $installMutex.Dispose() }
    if ($deploymentLock) { $deploymentLock.Dispose() }
  }
}
} catch {
  if ($DeferRestart -and $script:elevatedFailureLogged) { exit 1 }
  $hints = @()
  if ($installWithPackage -and $InstallerManifestSha256) {
    $hints += "可复用已固定安装包：deploy-desktop.bat -UseInstaller -InstallerPath `"$InstallerPath`""
  }
  Fail-DesktopDeployment -Message $_.Exception.Message -ExitCode 1 -Hints $hints -AlreadyLogged:$script:elevatedFailureLogged
}

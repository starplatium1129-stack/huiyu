# AI-CG-Studio 桌面端部署 —— 唯一入口
#
# 默认启动后先检测安装状态、已安装文件和源码/构建/升级包绑定，再自动选择：
# 无需部署、仅同步资源、复用升级包、重新封装或重新构建；首次安装/修复使用当前版本完整包。
# 自动模式默认静默安装并清理已登记的废弃资源，只需用户确认 UAC。
# -ResourcesOnly 仅同步已绑定静态资源，要求安装 EXE/DLL 与候选一致。
# -UseInstaller 复用已绑定安装包；显式指定 -InstallerPath 可覆盖自动选择。
#
# 常用组合：
#   双击 deploy-desktop.bat                 自动检测并选择最合适的部署方式
#   deploy-desktop.bat -SkipBuild           复用绑定构建，只封装并安装升级包
#   deploy-desktop.bat -UseInstaller        安装已有升级包
#   deploy-desktop.bat -NoRestart           部署后不自动启动
#
# 参数说明：
#   -SkipBuild     复用匹配当前源码的桌面构建绑定
#   -Cleanup       删除「源端已删除」的历史残留目录（见下 $STALE_ASSETS）
#   -UseInstaller  跑已有安装包，不重新构建或封装
#   -ResourcesOnly 只同步静态资源
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
  # 内部使用：提权子进程完成安装后交由非提权父进程启动，避免跨桌面维护握手。
  [switch]$DeferRestart,
  # 内部使用：父进程已在 UAC 前完成检测并选定模式，子进程不再重复检测。
  [switch]$DeploymentPlanApplied,
  [string]$InstallDir,
  [string]$InstallerPath,
  [string]$InstallerManifestSha256
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
function Write-DeploymentLog([string]$Message) {
  try { Add-Content -LiteralPath (Join-Path $root 'runtime\desktop-deploy-last.log') -Value $Message -Encoding UTF8 } catch { }
}
function Resolve-DesktopInstallDirectory([string]$Path) {
  $expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim().Trim('"'))
  if (-not $expanded) { throw '安装目录不能为空。' }
  if ($expanded -match '^[A-Za-z]:$') { throw '安装目录不能是驱动器根目录，请指定子目录。' }
  if (-not [IO.Path]::IsPathRooted($expanded)) { $expanded = Join-Path $root $expanded }
  $full = [IO.Path]::GetFullPath($expanded).TrimEnd([char[]]@('\','/'))
  # 去掉尾部分隔符，避免 UAC 子进程参数中的 \ 转义收尾引号。
  if ($full -match '^[A-Za-z]:$') { throw '安装目录不能是驱动器根目录，请指定子目录。' }
  return $full
}
$installRegistered = $false
if (-not $InstallDir) {
  $locations = @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AI-CG-Studio',
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AI-CG-Studio',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\AI-CG-Studio') |
    ForEach-Object { (Get-ItemProperty -LiteralPath $_ -ErrorAction SilentlyContinue).InstallLocation } |
    Where-Object { $_ -and $_.Trim() } |
    ForEach-Object {
      try { Resolve-DesktopInstallDirectory $_ }
      catch { Write-Host "[desktop:auto] 忽略无效的安装登记：$_" -ForegroundColor Yellow }
    } | Sort-Object -Unique
  if (@($locations).Count -gt 1) { throw "发现多个安装目录：$(($locations | ForEach-Object { "`n  $_" }) -join '')`n请用 -InstallDir 指定要修复的安装。" }
  $installRegistered = @($locations).Count -gt 0
  $InstallDir = if ($locations) { @($locations)[0] } else { 'C:\Program Files\AI-CG-Studio' }
}
$installDir = Resolve-DesktopInstallDirectory $InstallDir
$gatewayDir = Join-Path $installDir 'gateway'
$configRoot = Join-Path $env:APPDATA 'com.aics.studio'
. (Join-Path $root 'scripts\lib\desktop-deploy-guard.ps1')
# Only known retired application resources are removed; personal content is outside this list.
$STALE_ASSETS = @(
  'assets\character-references',
  'data\scenes\nene-core.json', 'data\scenes\nene-core.json.br', 'data\scenes\nene-core.json.gz',
  'data\scenes\nene-after-story.json', 'data\scenes\nene-after-story.json.br', 'data\scenes\nene-after-story.json.gz',
  'data\scenes\natsume-core.json', 'data\scenes\natsume-core.json.br', 'data\scenes\natsume-core.json.gz'
)
function Invoke-DesktopNpm {
  param([string[]]$Arguments)
  # Windows PowerShell turns native stderr into ErrorRecord objects. Stream it
  # as progress text and judge success only by the native process exit code.
  $previousPreference = $ErrorActionPreference
  $npmCommand = Get-Command npm.cmd -CommandType Application -ErrorAction Stop
  try {
    $ErrorActionPreference = 'Continue'
    & $npmCommand.Source @Arguments 2>&1 | ForEach-Object { Write-Host $_.ToString() }
    $buildExitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousPreference }
  if ($buildExitCode -ne 0) { throw "桌面构建/封装失败（退出码 $buildExitCode）；未关闭应用。" }
}
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
function Start-DesktopClientAndWait {
  param([string]$Prefix = '[6/6]')
  $appPath = Join-Path $installDir 'ai-cg-studio-desktop.exe'
  if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) { throw "未找到已安装的桌面端：$appPath" }
  Write-Host "$Prefix 启动桌面端 ..." -ForegroundColor Cyan
  Write-DeploymentLog "$Prefix 启动桌面端 ..."
  if ($isElevated) {
    # An elevated terminal cannot safely host the client; ask the interactive shell.
    Start-Process explorer.exe -ArgumentList "`"$appPath`"" -WindowStyle Normal
  } else {
    Start-Process -FilePath $appPath -WorkingDirectory $installDir -WindowStyle Normal | Out-Null
  }
  $startup = Wait-DesktopDeploymentReady -InstallDir $installDir -ConfigRoot $configRoot -TimeoutSeconds 120
  Show-DesktopDeploymentWindow -InstallDir $installDir -ConfigRoot $configRoot -HostPid $startup.hostPid
  Write-Host "宿主与所属 Rust 网关已就绪，Companion 窗口已显示（PID $($startup.hostPid)）" -ForegroundColor Green
  Write-DeploymentLog "宿主与所属 Rust 网关已就绪，Companion 窗口已显示（PID $($startup.hostPid)）"
  return $startup
}
function Get-DesktopProductVersion {
  (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
}
function Find-CurrentFullInstaller {
  $version = Get-DesktopProductVersion
  $name = "AI-CG-Studio_${version}_x64-full-setup.exe"
  $searchRoots = @((Join-Path $root 'runtime\desktop-updates'), $root)
  if ($env:USERPROFILE) { $searchRoots += (Join-Path $env:USERPROFILE 'Downloads') }
  $desktop = [Environment]::GetFolderPath('Desktop')
  if ($desktop) { $searchRoots += $desktop }
  foreach ($directory in ($searchRoots | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) } | Select-Object -Unique)) {
    $candidate = Join-Path $directory $name
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return Get-Item -LiteralPath $candidate }
  }
  return $null
}
function Select-CurrentFullInstaller {
  param([string]$State)
  $version = Get-DesktopProductVersion
  $full = Find-CurrentFullInstaller
  if (-not $full) {
    throw "检测到$State，但未找到当前版本 $version 的完整安装包。`n请下载 AI-CG-Studio_${version}_x64-full-setup.exe 及同名 .deployment.json，放到 runtime\desktop-updates 或 Downloads；也可运行 deploy-desktop.bat -UseInstaller -InstallerPath <完整包>。"
  }
  $manifest = "$($full.FullName).deployment.json"
  if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
    throw "完整包缺少同名部署清单：$manifest。请从发行附件保留 .deployment.json 后再部署。"
  }
  $verification = & node (Join-Path $root 'scripts\lib\desktop-installer-binding.js') verify $full.FullName 2>&1
  if ($LASTEXITCODE -ne 0) { throw "完整安装包校验失败：$($verification -join ' ')" }
  Write-Host "[desktop:auto] 使用当前版本完整包：$($full.FullName)" -ForegroundColor Cyan
  Write-DeploymentLog "[desktop:auto] 使用当前版本完整包：$($full.FullName)"
  return $full.FullName
}
function Complete-CurrentDeployment {
  $allProcesses = @(Get-DesktopInstallationProcesses -InstallDir $installDir)
  $hosts = @($allProcesses | Where-Object { $_.ProcessName -eq 'ai-cg-studio-desktop' })
  if ($hosts.Count -gt 1) {
    throw "DESKTOP_DUPLICATE_HOSTS: 同一安装有多个宿主（PID $($hosts.Id -join ', ')）；请从托盘退出全部实例后重试。"
  }
  if ($hosts.Count -eq 0 -and $allProcesses.Count -gt 0) {
    throw "DESKTOP_HOST_MISSING: 检测到网关仍在运行但宿主不存在（PID $($allProcesses.Id -join ', ')）；请先完成退出或重新部署。"
  }
  if ($NoRestart) {
    Write-Host '[desktop:auto] 已是最新，按 -NoRestart 不启动桌面端。' -ForegroundColor DarkGray
    Write-DeploymentLog '[desktop:auto] 已是最新，按 -NoRestart 不启动桌面端。'
    return 0
  }
  Write-Host '[desktop:auto] 已是最新，无需重复安装；启动或唤起桌面端并确认窗口显示。' -ForegroundColor Cyan
  Write-DeploymentLog '[desktop:auto] 已是最新，无需重复安装；启动或唤起桌面端并确认窗口显示。'
  $null = Start-DesktopClientAndWait -Prefix '[desktop:auto]'
  return 0
}

# Detect before UAC: an already-current install or a missing full installer must
# not require elevation, and the selected mode is passed to the child unchanged.
if (-not ($UseInstaller -or $ResourcesOnly -or $StartupRepair -or $SkipBuild -or $ForceBuild -or $DeploymentPlanApplied -or $InstallerPath)) {
  $QuietInstall = $true
  $Cleanup = $true
  $installHost = Join-Path $installDir 'ai-cg-studio-desktop.exe'
  $installationState = if (Test-Path -LiteralPath $installHost -PathType Leaf) { 'installed' } elseif ($installRegistered) { 'repair' } else { 'fresh' }
  $stateText = switch ($installationState) {
    'installed' { '已安装' }
    'repair' { '安装登记存在但宿主缺失' }
    default { '未安装' }
  }
  $running = @(Get-DesktopInstallationProcesses -InstallDir $installDir)
  $hosts = @($running | Where-Object { $_.ProcessName -eq 'ai-cg-studio-desktop' })
  $runningText = if ($hosts.Count) { "运行中（宿主 PID $($hosts.Id -join ', ')）" } elseif ($running.Count) { '网关运行中但宿主未运行' } else { '未运行' }
  Write-Host "[desktop:detect] 安装目录：$installDir（$stateText；桌面端$runningText）" -ForegroundColor Cyan
  Write-DeploymentLog "[desktop:detect] 安装目录：$installDir（$stateText；桌面端$runningText）"
  $bindingScripts = @('desktop-build-binding.js', 'desktop-installer-binding.js')
  if ($bindingScripts | Where-Object { -not (Test-Path -LiteralPath (Join-Path $root "scripts\lib\$_")) }) {
    Write-Host '[desktop:detect] 生成部署检测运行时 ...' -ForegroundColor DarkGray
    Push-Location $root
    try { Invoke-DesktopNpm -Arguments @('run','build:runtime') } finally { Pop-Location }
  }
  if ($installationState -eq 'fresh' -or $installationState -eq 'repair') {
    $InstallerPath = Select-CurrentFullInstaller -State $stateText
    $UseInstaller = $true
    Write-Host '[desktop:auto] 选择：发行完整包安装/修复' -ForegroundColor Cyan
    Write-DeploymentLog '[desktop:auto] 选择：发行完整包安装/修复'
  } else {
    $planJson = & node (Join-Path $root 'scripts\lib\desktop-build-binding.js') --deployment-plan $root $installDir 1 2>&1
    if ($LASTEXITCODE -ne 0) { throw "部署检测失败：$($planJson -join ' ')" }
    $plan = ($planJson | Out-String) | ConvertFrom-Json
    $modeText = switch ($plan.mode) {
      'current' { '无需部署，仅确认运行状态' }
      'resources' { '仅同步已绑定静态资源' }
      'installer' { '复用已绑定升级包' }
      'package' { '复用原生构建，重新封装升级包' }
      'build' { '重新构建并安装升级包' }
      default { $plan.mode }
    }
    Write-Host "[desktop:auto] 选择：$modeText" -ForegroundColor Cyan
    Write-Host "[desktop:auto] 原因：$($plan.reason)" -ForegroundColor DarkGray
    Write-DeploymentLog "[desktop:auto] 选择：$modeText；原因：$($plan.reason)"
    switch ($plan.mode) {
      'current' {
        $retiredResources = @($STALE_ASSETS | Where-Object { Test-Path -LiteralPath (Resolve-DesktopChildPath -Root $gatewayDir -Relative $_) })
        if (($Cleanup -and $retiredResources.Count -gt 0) -or $SyncLocalModels -or $AdoptProjectCatalog) {
          Write-Host '[desktop:auto] 程序已是最新；改为资源同步，执行指定的维护操作。' -ForegroundColor Cyan
          $ResourcesOnly = $true
          $SkipBuild = $true
          $QuietInstall = $false
        } else {
          $null = Complete-CurrentDeployment
          exit 0
        }
      }
      'resources' {
        $ResourcesOnly = $true
        $SkipBuild = $true
        $QuietInstall = $false
      }
      'installer' {
        if (-not $plan.installer) { throw '部署检测选择了升级包，但没有返回安装包路径。' }
        $UseInstaller = $true
        $InstallerPath = $plan.installer
      }
      'package' { $SkipBuild = $true }
      'build' { }
      default { throw "未知的部署选择：$($plan.mode)" }
    }
  }
  $DeploymentPlanApplied = $true
}

if ($StartupRepair -and ($UseInstaller -or $AdoptProjectCatalog)) { throw '-StartupRepair 不能与 -UseInstaller 或 -AdoptProjectCatalog 同时使用' }
if ($ResourcesOnly -and $UseInstaller) { throw '-ResourcesOnly 与 -UseInstaller 不能同时使用' }
$buildUpgrade = -not ($UseInstaller -or $ResourcesOnly -or $StartupRepair)
if ($ForceBuild -and (-not $buildUpgrade -or $SkipBuild)) { throw '-ForceBuild 仅用于默认部署，不能与显式复用/修复模式组合' }
$installWithPackage = $UseInstaller -or $buildUpgrade
if ($QuietInstall -and -not $installWithPackage) { throw '-QuietInstall 仅用于安装包部署' }
if ($InstallerPath -and -not $UseInstaller) { throw '-InstallerPath 仅可与 -UseInstaller 一起使用' }
$setup = $null
if ($UseInstaller) {
  $setup = if ($InstallerPath) { Get-Item -LiteralPath $InstallerPath -ErrorAction Stop } else {
    $version = Get-DesktopProductVersion
    Get-ChildItem -Path (Join-Path $root 'runtime\desktop-updates') -Filter "*_${version}_x64*-upgrade-setup.exe" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
  }
  if (-not $setup) { throw '没有当前版本的升级包；去掉 -UseInstaller 先构建升级包。首次安装/修复请用 -InstallerPath 明确选择发行完整包。' }
  if ($setup.PSIsContainer -or $setup.Extension -ine '.exe') { throw 'InstallerPath 必须指向已验收的 EXE 安装包' }
  # Keep the exact candidate across UAC, even if another build finishes meanwhile.
  $InstallerPath = $setup.FullName
}
function Assert-FixedInstaller {
  param([switch]$Installed)
  $bindingArgs = @((Join-Path $root 'scripts\lib\desktop-installer-binding.js'), 'verify', $InstallerPath, $InstallerManifestSha256)
  if ($Installed) { $bindingArgs += $installDir }
  & node @bindingArgs
  if ($LASTEXITCODE -ne 0) { throw 'DESKTOP_INSTALLER_BINDING: 固定安装包、校验清单或已安装文件不匹配。' }
}
function Freeze-FixedInstaller {
  param([string]$Candidate)
    # Older packages gain a portable manifest from their original verified build
    # record and host bytes, without reading current application source or SDK.
    $preparedInstaller = & node (Join-Path $root 'scripts\lib\desktop-installer-binding.js') prepare $Candidate $root
    if ($LASTEXITCODE -ne 0) { throw '指定安装包的固定身份无法确认；未关闭应用。' }
    $manifestHash = ($preparedInstaller | ConvertFrom-Json).manifestSha256
    $deploymentCopy = Resolve-DesktopChildPath -Root $root -Relative ('runtime\desktop-deploy-packages\' + [Guid]::NewGuid().ToString('N'))
    $frozenInstaller = & node (Join-Path $root 'scripts\lib\desktop-installer-binding.js') freeze $Candidate $deploymentCopy $manifestHash
    if ($LASTEXITCODE -ne 0) { throw '本次安装包副本无法确认；未关闭应用。' }
    return ($frozenInstaller | ConvertFrom-Json)
}
if ($UseInstaller) {
  if (-not $InstallerManifestSha256) {
    $selectedInstaller = Freeze-FixedInstaller -Candidate $InstallerPath
    $InstallerPath = $selectedInstaller.installer
    $InstallerManifestSha256 = $selectedInstaller.manifestSha256
    $setup = Get-Item -LiteralPath $InstallerPath
  }
  Assert-FixedInstaller
}
# Read-only preflight: UAC denial, missing payload or build failure must leave
# the user's running application untouched. Actual drain occurs before writes.
if (@(Get-DesktopInstallationProcesses -InstallDir $installDir).Count -gt 0) {
  Assert-DesktopMaintenanceAvailable -InstallDir $installDir -ConfigRoot $configRoot
} else { Assert-DesktopDeploymentStopped -InstallDir $installDir -ConfigRoot $configRoot }

# 提权：注意要把已传入的参数一起带过去，否则 UAC 后的新进程会丢掉它们
# （旧版这里只传脚本路径，导致 -SkipBuild 静默失效、白白重跑一次 build）。
if (-not $isElevated) {
  Write-Host '需要管理员权限，正在弹出 UAC 授权窗口，请点击"是"' -ForegroundColor Yellow
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
  if ($DeploymentPlanApplied) { $argList += '-DeploymentPlanApplied' }
  # The elevated process must not launch the desktop client: its window station
  # may differ from the interactive one, making the maintenance handshake fail.
  # It installs and exits; this non-elevated parent starts the client afterwards.
  $argList += '-DeferRestart'
  $argList += @('-InstallDir', "`"$installDir`"")
  # Start-Process -Wait includes descendants, so the restarted client would
  # keep this wrapper alive. Wait only for the elevated deployment process.
  $logReader = $null
  $elevatedProcess = $null
  try {
    $logPath = Join-Path $root 'runtime\desktop-deploy-last.log'
    if (Test-Path -LiteralPath $logPath) {
      $logStream = [IO.File]::Open($logPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
      $logReader = New-Object IO.StreamReader($logStream, [Text.Encoding]::UTF8, $true)
      $null = $logReader.ReadToEnd()
    }
    try {
      $elevatedProcess = Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList ($argList -join ' ') -PassThru
    } catch {
      $canceled = $_.Exception.Message -match 'cancel|canceled|cancelled|取消' -or
        ($_.Exception.PSObject.Properties.Name -contains 'NativeErrorCode' -and $_.Exception.NativeErrorCode -eq 1223)
      if ($canceled) { Write-Host '已取消 UAC 授权，部署未开始。' -ForegroundColor Yellow; exit 1223 }
      throw
    }
    # Retain the handle before exit so Windows PowerShell 5.1 can read ExitCode.
    $null = $elevatedProcess.Handle
    do {
      $finished = $elevatedProcess.WaitForExit(750)
      if (-not $logReader -and (Test-Path -LiteralPath $logPath)) {
        $logStream = [IO.File]::Open($logPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        $logReader = New-Object IO.StreamReader($logStream, [Text.Encoding]::UTF8, $true)
      }
      if ($logReader) { $chunk = $logReader.ReadToEnd(); if ($chunk) { Write-Host -NoNewline $chunk } }
    } while (-not $finished)
    $deploymentExitCode = $elevatedProcess.ExitCode
    if ($null -eq $deploymentExitCode) { throw 'DESKTOP_DEPLOY_EXITCODE: 无法读取提权部署进程的退出码。' }
    if ($deploymentExitCode -eq 73) { Write-Host '另一个部署正在执行，请等待它完成后再同步。' -ForegroundColor Yellow }
  } finally { if ($logReader) { $logReader.Dispose() }; if ($elevatedProcess) { $elevatedProcess.Dispose() } }
  if ($deploymentExitCode -eq 0 -and -not $NoRestart) {
    try {
      $null = Start-DesktopClientAndWait
    } catch {
      Write-Host "[desktop:failed] $($_.Exception.Message)" -ForegroundColor Red
      Write-DeploymentLog "[desktop:failed] $($_.Exception.Message)"
      $deploymentExitCode = 1
    }
  }
  exit $deploymentExitCode
}

$deploymentLock = $null
try {
  $lockPath = Resolve-DesktopChildPath -Root $root -Relative 'runtime\desktop-deploy.lock'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $lockPath) | Out-Null
  $deploymentLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
} catch [IO.IOException] {
  if (($_.Exception.GetBaseException().HResult -band 0xffff) -notin @(32,33)) { throw }
  Write-Host 'DESKTOP_DEPLOY_BUSY: 当前工作区已有部署。' -ForegroundColor Yellow
  exit 73
}
$transcriptStarted = $false
try {
Start-Transcript -Path (Join-Path $root 'runtime\desktop-deploy-last.log') -Append | Out-Null
$transcriptStarted = $true
$deployTimer = [Diagnostics.Stopwatch]::StartNew()
$phaseTimer = [Diagnostics.Stopwatch]::StartNew()
function Write-DesktopDuration([string]$Phase) {
  Write-Host ('[desktop:timing] {0}: {1:F2}s' -f $Phase, $phaseTimer.Elapsed.TotalSeconds)
  $phaseTimer.Restart()
}
$stageGateway = Join-Path $root 'desktop-tauri\src-tauri\resources\gateway'
$hostExecutable = $null
# Validate selected source/build/distribution before drain and before restart.
function Assert-CurrentBuildBinding {
  if ($installWithPackage) { Assert-FixedInstaller; return }
  & node (Join-Path $root 'scripts\lib\desktop-build-binding.js') $root $InstallerPath
  if ($LASTEXITCODE -ne 0) { throw 'DESKTOP_BUILD_BINDING: 源码/资源/安装包与构建回执不匹配；请重新完整构建。' }
  $buildReceipt = Get-Content -LiteralPath (Join-Path $root 'runtime\delivery-evidence\desktop-build-binding.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $buildProfile = if ($buildReceipt.buildProfile) { $buildReceipt.buildProfile } else { 'release' }
  if ($buildProfile -notin @('release', 'desktop-local')) { throw 'DESKTOP_BUILD_BINDING: 未知构建档位。' }
  $script:hostExecutable = Join-Path $root "desktop-tauri\src-tauri\target\$buildProfile\ai-cg-studio-desktop.exe"
}
if ($buildUpgrade) {
  Write-Host '[1/6] 准备本机快速构建与轻量升级包 ...' -ForegroundColor Cyan
  $candidate = $null
  if (-not $SkipBuild -and -not $ForceBuild -and -not $DeploymentPlanApplied) {
    if (-not (Test-Path -LiteralPath (Join-Path $root 'scripts\lib\desktop-build-binding.js'))) {
      Push-Location $root
      try { Invoke-DesktopNpm -Arguments @('run','build:runtime') } finally { Pop-Location }
    }
    $selection = & node (Join-Path $root 'scripts\lib\desktop-build-binding.js') --deployment-plan $root
    if ($LASTEXITCODE -ne 0) { throw '无法判断构建复用状态；部署已停止。' }
    $plan = $selection | ConvertFrom-Json
    Write-Host "[desktop:auto] $($plan.reason)" -ForegroundColor Cyan
    switch ($plan.mode) {
      'installer' { $candidate = $plan.installer }
      'package' { $SkipBuild = $true }
      'build' { }
      default { throw '未知的部署选择，部署已停止。' }
    }
  } else { Write-Host $(if ($ForceBuild) { '[desktop:auto] 按 -ForceBuild 重建' } elseif ($SkipBuild) { '[desktop:auto] 按 -SkipBuild 复用原生构建并重新封装' } else { '[desktop:auto] 按检测结果重新构建桌面端' }) }
  if (-not $candidate) {
    Push-Location $root
    try {
      $upgradeArgs = @('run', 'release:desktop', '--', '--manual', '--upgrade-only', '--install-dir', $installDir)
      if ($SkipBuild) { $upgradeArgs += '--skip-build' }
      Invoke-DesktopNpm -Arguments $upgradeArgs
      $version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
      $candidate = Join-Path $root "runtime\desktop-updates\AI-CG-Studio_${version}_x64-local-upgrade-setup.exe"
    } finally { Pop-Location }
  }
  $InstallerPath = (Get-Item -LiteralPath $candidate).FullName
  $selectedInstaller = Freeze-FixedInstaller -Candidate $InstallerPath
  $InstallerPath = $selectedInstaller.installer
  $InstallerManifestSha256 = $selectedInstaller.manifestSha256
  $setup = Get-Item -LiteralPath $InstallerPath
} elseif (-not $installWithPackage -and -not $SkipBuild) {
  Write-Host '[1/6] 构建并绑定 Rust 桌面候选 ...' -ForegroundColor Cyan
  Push-Location $root
  try { Invoke-DesktopNpm -Arguments @('run','build:tauri','--','--local') }
  finally { Pop-Location }
} else { Write-Host $(if ($UseInstaller) { '[1/6] 复用本次固定安装包' } else { '[1/6] 复用当前已绑定构建' }) -ForegroundColor DarkGray }
Assert-CurrentBuildBinding
if (-not $installWithPackage) { Assert-DesktopRuntimeMatches -StageGateway $stageGateway -InstallDir $installDir -HostExecutable $hostExecutable }
Write-DesktopDuration '构建准备与首次校验'
Stop-DesktopForDeployment -InstallDir $installDir -ConfigRoot $configRoot
Write-DesktopDuration '应用维护退出'
Write-Host '[2/6] 宿主与自有 Rust 网关已退出，工作区锁已释放' -ForegroundColor DarkGray
Assert-CurrentBuildBinding
if (-not $installWithPackage) { Assert-DesktopRuntimeMatches -StageGateway $stageGateway -InstallDir $installDir -HostExecutable $hostExecutable }
Write-DesktopDuration '写入前校验'
if ($Cleanup) {
  foreach ($relative in $STALE_ASSETS) {
    $target = Resolve-DesktopChildPath -Root $gatewayDir -Relative $relative
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  }
}
Write-Host '[3/6] 安装边界核验完成' -ForegroundColor DarkGray
if ($installWithPackage) {
  Write-Host '[4/6] 运行本次已绑定的安装包 ...' -ForegroundColor Cyan
  # NSIS requires /D= last and unquoted; the modern wrapper forwards it and
  # also uses it as the default directory for the interactive installer.
  $installerArgs = @("/D=$installDir")
  $setupProcess = if ($QuietInstall) {
    Start-Process -FilePath $setup.FullName -ArgumentList (@('/S') + $installerArgs) -WindowStyle Hidden -Wait -PassThru
  } else { Start-Process -FilePath $setup.FullName -ArgumentList $installerArgs -Wait -PassThru }
  if ($setupProcess.ExitCode -ne 0) { throw "安装程序失败，退出码 $($setupProcess.ExitCode)" }
} else {
  Write-Host '[4/6] 同步已绑定的 Rust 静态资源 ...' -ForegroundColor Cyan
  # data precedes dist; copy only staged allowlisted content, never raw user data.
  $directories = if ($StartupRepair) { @('docs') } else { @('data','assets','docs','tools','scripts\lib','native-licenses','dist') }
  foreach ($relative in $directories) {
    $source = Resolve-DesktopChildPath -Root $stageGateway -Relative $relative
    $target = Resolve-DesktopChildPath -Root $gatewayDir -Relative $relative
    if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Missing staged resource: $relative" }
    if (Test-Path -LiteralPath $target) {
      if (@(Get-ChildItem -LiteralPath $target -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count -gt 0) { throw 'DESKTOP_LINK_UNSUPPORTED: 安装资源树含链接，拒绝穿过链接覆盖文件。' }
    }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Get-ChildItem -LiteralPath $source -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force }
  }
  if (-not $StartupRepair) {
    foreach ($name in @('resource-layers.json','rust-runtime-build.json','native-dependencies.windows-x64.json')) {
      Copy-Item -LiteralPath (Resolve-DesktopChildPath $stageGateway $name) -Destination (Resolve-DesktopChildPath $gatewayDir $name) -Force
    }
  }
  Copy-Item -LiteralPath (Join-Path $root 'desktop-tauri\src-tauri\icons\icon.ico') -Destination (Resolve-DesktopChildPath $installDir 'huiyu-icon.ico') -Force
  if ($StartupRepair) {
    $shell = New-Object -ComObject WScript.Shell
    $icon = Resolve-DesktopChildPath $installDir 'huiyu-icon.ico'
    foreach ($directory in @([Environment]::GetFolderPath('CommonDesktopDirectory'),[Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('CommonPrograms'),[Environment]::GetFolderPath('Programs'))) {
      if (-not $directory -or -not (Test-Path -LiteralPath $directory)) { continue }
      Get-ChildItem -LiteralPath $directory -Filter '*.lnk' -File -Recurse | ForEach-Object {
        $shortcut = $shell.CreateShortcut($_.FullName)
        if ($shortcut.TargetPath -ieq (Join-Path $installDir 'ai-cg-studio-desktop.exe')) { $shortcut.IconLocation = "$icon,0"; $shortcut.Save() }
      }
    }
  }
}
if ($SyncLocalModels) {
  $modelSource = Join-Path $root 'runtime\live2d-imports'
  $modelTarget = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'com.aics.studio\gateway\live2d-imports'
  node (Join-Path $root 'scripts\maintenance\sync-local-live2d.js') --source $modelSource --target $modelTarget --apply
  if ($LASTEXITCODE -ne 0) { throw '本机 Live2D 同步核验失败' }
}
Write-DesktopDuration '安装与资源同步'
Assert-CurrentBuildBinding
if ($installWithPackage) { Assert-FixedInstaller -Installed }
else { Assert-DesktopRuntimeMatches -StageGateway $stageGateway -InstallDir $installDir -HostExecutable $hostExecutable }
Write-DesktopDuration '安装后校验'
if (-not $StartupRepair) {
  $catalogArguments = @((Join-Path $root 'scripts\lib\desktop-catalog-update.js'), $gatewayDir, (Join-Path $configRoot 'gateway'))
  if ($AdoptProjectCatalog) { $catalogArguments += '--adopt-project-catalog' }
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & node @catalogArguments 2>&1 | ForEach-Object { Write-Host $_.ToString() }
    $catalogExitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousPreference }
  if ($catalogExitCode -ne 0) { throw '内容库更新未完成；请检查上述原始错误及备份，不能仅凭素材安装成功判断人物已更新。' }
  Write-DesktopDuration '内容快照导入与核对'
}
Write-Host '[5/6] Rust EXE、宿主和两份 native DLL 与候选哈希一致；不冒充模型验收' -ForegroundColor DarkGray
$webviewBase = Join-Path $env:LOCALAPPDATA 'com.aics.studio\EBWebView\Default'
foreach ($name in @('Cache','Code Cache','GPUCache')) {
  $target = Resolve-DesktopChildPath -Root $webviewBase -Relative $name
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue }
}
if ($NoRestart) {
  Write-Host '[6/6] 按 -NoRestart 保持退出' -ForegroundColor DarkGray
} elseif ($DeferRestart) {
  Write-Host '[6/6] 部署完成；由非提权父进程启动桌面端 ...' -ForegroundColor DarkGray
} else {
  $null = Start-DesktopClientAndWait
}
Write-DesktopDuration '缓存与启动确认'
Write-Host ('[desktop:timing] 部署总耗时: {0:F2}s' -f $deployTimer.Elapsed.TotalSeconds)
} catch {
  Write-Host "[desktop:failed] $($_.Exception.Message)" -ForegroundColor Red
  if ($installWithPackage -and $InstallerManifestSha256) {
    Write-Host "已固定的安装包仍可复用：$InstallerPath"
    Write-Host '修正上述原因后，可用 -UseInstaller -InstallerPath 指定此包继续，无需重复构建。'
  }
  throw
} finally {
  try { if ($transcriptStarted) { Stop-Transcript | Out-Null } }
  finally { if ($deploymentLock) { $deploymentLock.Dispose() } }
}

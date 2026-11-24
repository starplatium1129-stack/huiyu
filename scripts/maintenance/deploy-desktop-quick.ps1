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
  [string]$InstallerManifestSha256
)

$ErrorActionPreference = 'Stop'
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
function Write-DeploymentLog([string]$Message) {
  try { Add-Content -LiteralPath $deploymentLogPath -Value $Message -Encoding UTF8 } catch { }
}
function Fail-DesktopDeployment([string]$Message, [int]$ExitCode = 1, [string[]]$Hints = @()) {
  Write-DeploymentLog "[desktop:failed] $Message"
  if ($DeferRestart) {
    Write-Host "[desktop:failed] $Message" -ForegroundColor Red
  } else {
    $details = @($Message) + @($Hints) + @("日志位置：$root\runtime\desktop-deploy-last.log")
    if (Get-Command Write-DesktopSummary -ErrorAction SilentlyContinue) {
      Write-DesktopSummary -Kind 'error' -Title '桌面部署未完成' -Details $details
    } else {
      Write-Host "[desktop:failed] $Message" -ForegroundColor Red
    }
    Publish-DeploymentLog
  }
  exit $ExitCode
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
. (Join-Path $root 'scripts\lib\desktop-deploy-output.ps1')
$deploymentLogPath = Resolve-DesktopChildPath -Root $root -Relative $logRelative
New-Item -ItemType Directory -Path (Split-Path -Parent $deploymentLogPath) -Force | Out-Null
function Publish-DeploymentLog {
  if (Test-Path -LiteralPath $deploymentLogPath -PathType Leaf) {
    $last = Resolve-DesktopChildPath -Root $root -Relative 'runtime\desktop-deploy-last.log'
    $temp = Resolve-DesktopChildPath -Root $root -Relative "runtime\desktop-deploy-logs\$DeploymentLogId.last.tmp"
    try {
      [IO.File]::Copy($deploymentLogPath, $temp, $true)
      if ([IO.File]::Exists($last)) { [IO.File]::Replace($temp, $last, [Management.Automation.Language.NullString]::Value) }
      else { [IO.File]::Move($temp, $last) }
    } finally { if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) } }
  }
}
function Remove-DirectDeploymentPlan {
  if (-not $DirectPlanId) { return }
  $directory = Resolve-DesktopChildPath -Root $root -Relative "runtime\desktop-deploy-packages\$DirectPlanId"
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) { return }
  $plan = Resolve-DesktopChildPath -Root $directory -Relative 'local-plan.json'
  if (@(Get-ChildItem -LiteralPath $directory -Force).Count -eq 1 -and [IO.File]::Exists($plan)) {
    [IO.File]::Delete($plan)
    [IO.Directory]::Delete($directory, $false)
  }
}
function Remove-StaleDeploymentCopies {
  $packages = Resolve-DesktopChildPath -Root $root -Relative 'runtime\desktop-deploy-packages'
  if (Test-Path -LiteralPath $packages -PathType Container) {
    $frozen = @(Get-ChildItem -LiteralPath $packages -Directory -Force | Where-Object {
      $_.Name -cmatch '^[a-f0-9]{32}$' -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)
    } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip 3)
    foreach ($candidate in $frozen) {
      $directory = Resolve-DesktopChildPath -Root $packages -Relative $candidate.Name
      $files = @(Get-ChildItem -LiteralPath $directory -Force)
      if ($files | Where-Object { $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
          $_.LinkType -or $_.Name -notmatch '^(local-plan\.json|[^/\\]+\.exe(?:\.deployment\.json)?)$' }) { continue }
      foreach ($file in $files) { [IO.File]::Delete((Resolve-DesktopChildPath -Root $directory -Relative $file.Name)) }
      [IO.Directory]::Delete($directory, $false)
    }
  }
  $logs = Split-Path -Parent $deploymentLogPath
  $oldLogs = @(Get-ChildItem -LiteralPath $logs -File -Filter '*.log' -Force | Where-Object {
    $_.Name -cmatch '^[a-f0-9]{32}\.log$' -and -not $_.LinkType -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)
  } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip 3)
  foreach ($file in $oldLogs) { [IO.File]::Delete((Resolve-DesktopChildPath -Root $logs -Relative $file.Name)) }
}
$referenceIdList = @()
if ($ReferenceIds) {
  if ($ReferenceIds -cnotmatch '^[a-z0-9][a-z0-9_]*(,[a-z0-9][a-z0-9_]*)*$') { throw 'ReferenceIds 必须是逗号分隔的小写角色 ID。' }
  if ($StartupRepair) { throw '-ReferenceIds 不能与 -StartupRepair 同时使用。' }
  $referenceIdList = @($ReferenceIds.Split(',') | Select-Object -Unique)
}
function Assert-ReferenceSyncAvailable {
  $workspaceFile = Join-Path $configRoot 'ai-workspace.json'
  $workspaceRoot = if (Test-Path -LiteralPath $workspaceFile -PathType Leaf) {
    (Get-Content -LiteralPath $workspaceFile -Raw -Encoding UTF8 | ConvertFrom-Json).root
  } else { $null }
  if (-not $workspaceRoot) { $workspaceRoot = Join-Path $configRoot 'AI' }
  $referenceRoots = if ($env:AICS_CHARACTER_REF_ROOT) {
    $explicit = $env:AICS_CHARACTER_REF_ROOT
    if (-not [IO.Path]::IsPathRooted($explicit)) { $explicit = Join-Path $gatewayDir $explicit }
    if (-not (Test-Path -LiteralPath $explicit -PathType Container)) { throw 'REFERENCE_ROOT_INVALID: 指定的参考素材目录不存在。' }
    @($explicit)
  } else {
    @((Join-Path $workspaceRoot 'CharacterReferences'), (Join-Path $installDir 'AI\CharacterReferences'), (Join-Path $gatewayDir 'assets\character-references'))
  }
  $activeReferenceRoot = $referenceRoots | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -First 1
  if ($activeReferenceRoot -and (Test-Path -LiteralPath (Join-Path $activeReferenceRoot 'reference-release.json') -PathType Leaf)) {
    throw 'REFERENCE_RELEASE_MANAGED: 当前参考素材使用受保护的发布版本，请通过参考库发布流程同步，未改写个人分片。'
  }
}
if ($referenceIdList.Count) { Assert-ReferenceSyncAvailable }
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
function Start-DesktopClientAndWait {
  param([string]$Prefix = '[6/6]')
  $appPath = Join-Path $installDir 'ai-cg-studio-desktop.exe'
  if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) { throw "未找到已安装的桌面端：$appPath" }
  Write-Host "$Prefix 启动桌面端并确认就绪 ..." -ForegroundColor Cyan
  Write-DeploymentLog "$Prefix 启动桌面端并确认就绪 ..."
  if ($isElevated) {
    # An elevated terminal cannot safely host the client; ask the interactive shell.
    Start-Process explorer.exe -ArgumentList "`"$appPath`"" -WindowStyle Normal
  } else {
    Start-Process -FilePath $appPath -WorkingDirectory $installDir -WindowStyle Normal | Out-Null
  }
  $startup = Wait-DesktopDeploymentReady -InstallDir $installDir -ConfigRoot $configRoot -TimeoutSeconds 120
  $visible = Show-DesktopDeploymentWindow -InstallDir $installDir -ConfigRoot $configRoot -HostPid $startup.hostPid
  Write-Host "  ✓ 宿主与 Rust 网关已就绪，$visible（PID $($startup.hostPid)）" -ForegroundColor Green
  Write-DeploymentLog "[desktop:ok] 宿主与 Rust 网关已就绪，$visible（PID $($startup.hostPid)）"
  return [pscustomobject]@{ hostPid = $startup.hostPid; visible = $visible }
}
function Get-DesktopProductVersion {
  (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
}
function Get-DesktopGitSummary {
  $git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue
  if (-not $git) { return [pscustomobject]@{ Text = ''; Warning = '' } }
  try {
    $branch = (& $git.Source -C $root branch --show-current 2>$null | Out-String).Trim()
    $head = (& $git.Source -C $root rev-parse --short HEAD 2>$null | Out-String).Trim()
    $dirty = (& $git.Source -C $root status --porcelain 2>$null | Out-String).Trim()
    $label = if ($branch) { $branch } else { 'detached' }
    $suffix = if ($dirty) { ' · 有未提交改动' } else { '' }
    $text = if ($head) { "分支 $label @ $head$suffix" } else { "分支 $label$suffix" }
    $warning = if ($branch -and $branch -ne 'main') { "当前位于分支 $branch（建议在 main 工作区执行桌面部署）" } else { '' }
    return [pscustomobject]@{ Text = $text; Warning = $warning }
  } catch {
    return [pscustomobject]@{ Text = ''; Warning = '' }
  }
}
function Get-DesktopDirectInstallEligibility {
  $version = Get-DesktopProductVersion
  if ($installDir -notmatch '^[a-zA-Z]:\\.+') {
    return [pscustomobject]@{ Eligible = $false; InstalledVersion = ''; Reason = '安装路径不是本机子目录，需通过安装包处理' }
  }
  $hostPath = Resolve-DesktopChildPath -Root $installDir -Relative 'ai-cg-studio-desktop.exe'
  $uninstaller = Resolve-DesktopChildPath -Root $installDir -Relative 'uninstall.exe'
  if (-not [IO.File]::Exists($hostPath)) {
    return [pscustomobject]@{ Eligible = $false; InstalledVersion = ''; Reason = '未检测到已安装的桌面宿主，需使用完整安装包' }
  }
  $installedVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($hostPath).ProductVersion
  if (-not [IO.File]::Exists($uninstaller)) {
    return [pscustomobject]@{ Eligible = $false; InstalledVersion = $installedVersion; Reason = '缺少卸载程序，需通过安装包修复登记' }
  }
  if ($installedVersion -ne $version) {
    return [pscustomobject]@{ Eligible = $false; InstalledVersion = $installedVersion; Reason = "版本变化（已装 v$installedVersion → 目标 v$version），需通过升级包更新安装登记" }
  }
  $versions = @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AI-CG-Studio', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\AI-CG-Studio') |
    ForEach-Object { Get-ItemProperty -LiteralPath $_ -ErrorAction SilentlyContinue } |
    Where-Object { $_.InstallLocation -and (Resolve-DesktopInstallDirectory $_.InstallLocation) -ieq $installDir } |
    Select-Object -ExpandProperty DisplayVersion -Unique
  if (@($versions).Count -ne 1 -or $versions -ne $version) {
    return [pscustomobject]@{ Eligible = $false; InstalledVersion = $installedVersion; Reason = '系统卸载登记版本与目标版本不一致，需通过安装包同步登记' }
  }
  $webview = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  foreach ($prefix in @('HKLM:\Software','HKLM:\Software\WOW6432Node','HKCU:\Software','HKCU:\Software\WOW6432Node')) {
    $installedWebview = (Get-ItemProperty -LiteralPath "$prefix\Microsoft\EdgeUpdate\Clients\$webview" -ErrorAction SilentlyContinue).pv
    $parsed = $null
    if ([Version]::TryParse($installedWebview, [ref]$parsed) -and $parsed.Major -gt 0) {
      return [pscustomobject]@{ Eligible = $true; InstalledVersion = $installedVersion; Reason = "已登记同版本（v$version）安装，可直接按清单快速直写差异" }
    }
  }
  return [pscustomobject]@{ Eligible = $false; InstalledVersion = $installedVersion; Reason = '未检测到 WebView2 运行时，需通过安装包引导安装' }
}
function Test-DesktopDirectInstall {
  return (Get-DesktopDirectInstallEligibility).Eligible
}

function Invoke-BoundDirectDeployment([string]$Action, [string]$Id, [string]$Sha256) {
  $arguments = @((Join-Path $root 'scripts\lib\desktop-direct-install.js'), $Action, $root, $installDir, $Id)
  if ($Sha256) { $arguments += $Sha256 }
  $output = & node @arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "本机绑定部署失败：$($output -join ' ')" }
  return ($output | Out-String | ConvertFrom-Json)
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
  $elapsed = '{0:F1}s' -f $script:overallTimer.Elapsed.TotalSeconds
  if ($NoRestart) {
    Write-DeploymentLog '[desktop:auto] 已是最新，按 -NoRestart 不启动桌面端。'
    Write-DesktopSummary -Kind 'success' -Title "已是最新版本，无需部署（总耗时 $elapsed）" -Details @('按 -NoRestart 参数保持桌面端关闭。')
    return 0
  }
  if ($hosts.Count -eq 1) {
    $startup = Wait-DesktopDeploymentReady -InstallDir $installDir -ConfigRoot $configRoot -TimeoutSeconds 15
    Write-DeploymentLog "[desktop:ok] 已是最新，宿主和网关正在运行（PID $($startup.hostPid)）。"
    Write-DesktopSummary -Kind 'success' -Title "已是最新版本，无需重新安装（总耗时 $elapsed）" -Details @(
      "宿主与 Rust 网关正在运行（PID $($startup.hostPid)）",
      "安装目录：$installDir"
    )
    return 0
  }
  Write-Host '  ▸ 文件已是最新，无需重复安装，正在启动桌面端 ...' -ForegroundColor Cyan
  Write-DeploymentLog '[desktop:auto] 已是最新，无需重复安装；启动或唤起桌面端并确认窗口显示。'
  $started = Start-DesktopClientAndWait -Prefix '[desktop:auto]'
  $elapsed = '{0:F1}s' -f $script:overallTimer.Elapsed.TotalSeconds
  Write-DesktopSummary -Kind 'success' -Title "已是最新版本，桌面端已启动（总耗时 $elapsed）" -Details @(
    "运行状态：$($started.visible)（PID $($started.hostPid)）",
    "安装目录：$installDir"
  )
  return 0
}

try {
$productVersion = Get-DesktopProductVersion
$installHost = Join-Path $installDir 'ai-cg-studio-desktop.exe'
$installationState = if (Test-Path -LiteralPath $installHost -PathType Leaf) { 'installed' } elseif ($installRegistered) { 'repair' } else { 'fresh' }
$directEligibility = Get-DesktopDirectInstallEligibility
$stateText = switch ($installationState) {
  'installed' {
    if ($directEligibility.InstalledVersion) { "已安装 v$($directEligibility.InstalledVersion)" } else { '已安装' }
  }
  'repair' { '安装登记存在但宿主缺失' }
  default { '未安装' }
}
$runningNow = @(Get-DesktopInstallationProcesses -InstallDir $installDir)
$runningHosts = @($runningNow | Where-Object { $_.ProcessName -eq 'ai-cg-studio-desktop' })
$runningText = if ($runningHosts.Count) { "运行中（PID $($runningHosts.Id -join ', ')）" } elseif ($runningNow.Count) { '仅网关运行（宿主未运行）' } else { '未运行' }

if (-not $DeferRestart) {
  $gitSummary = Get-DesktopGitSummary
  Write-DesktopBanner -Version $productVersion -GitInfo $gitSummary.Text -BranchWarning $gitSummary.Warning -InstallDir $installDir -InstallState $stateText -RunningState $runningText
  Write-DeploymentLog "[desktop:detect] 版本 v$productVersion；安装目录：$installDir（$stateText；桌面端$runningText）"
}

# Direct deployment is restricted to a registered machine install at the same
# version. Installers still own registration, version upgrades and repair.
if (-not ($UseInstaller -or $ResourcesOnly -or $StartupRepair -or $InstallerPath)) {
  $eligible = $directEligibility.Eligible
  if ($DirectInstall -and -not $eligible) { throw "本机直写条件已变化（$($directEligibility.Reason)），请从原入口重新选择部署。" }
  $DirectInstall = $eligible
}
if ($DirectInstall -and ($UseInstaller -or $ResourcesOnly -or $StartupRepair -or $InstallerPath)) { throw '本机直写不能与安装包、资源同步或修复组合' }
if ($DirectPlanId -or $DirectPlanSha256) {
  if (-not $DirectInstall -or $DirectPlanId -cnotmatch '^[a-f0-9]{32}$' -or $DirectPlanSha256 -cnotmatch '^[a-f0-9]{64}$') {
    throw '无效的直写部署清单绑定'
  }
}
if ($DirectInstall -and -not ($DirectPlanId -or $DeploymentPlanApplied)) {
  if (-not (Test-Path -LiteralPath (Join-Path $root 'scripts\lib\desktop-direct-install.js'))) {
    Write-Host '  · 准备部署辅助脚本 ...' -ForegroundColor DarkGray
    Push-Location $root
    try { Invoke-DesktopNpm -Arguments @('run','build:runtime') -PrettyConsole:(-not $DeferRestart) } finally { Pop-Location }
  }
  $needsRebuild = $ForceBuild.IsPresent
  $rebuildReason = if ($ForceBuild) { '已指定 -ForceBuild，强制执行本机重建' } else { '' }
  if (-not $needsRebuild) {
    $plan = Invoke-BoundDirectDeployment -Action prepare -Id ([Guid]::NewGuid().ToString('N'))
    if ($plan.mode -eq 'build') {
      if ($SkipBuild) { throw "-SkipBuild 无可复用构建：$($plan.reason)" }
      $needsRebuild = $true
      $rebuildReason = "本机构建需要更新（$($plan.reason)）"
    } else {
      $DirectPlanId = $plan.id
      $DirectPlanSha256 = $plan.sha256
      $missingLedger = -not (Test-Path -LiteralPath (Join-Path $installDir '.huiyu-installed-resources.json') -PathType Leaf)
      if ($plan.mode -eq 'current' -and -not ($missingLedger -or $SyncLocalModels -or $AdoptProjectCatalog -or $referenceIdList.Count)) {
        Write-DesktopDecision -Mode '已是最新（免提权、免构建）' -Reason "已安装的全部 $($plan.files) 项文件与当前源码和构建完全一致"
        try { $null = Complete-CurrentDeployment; exit 0 } finally { Remove-DirectDeploymentPlan; Publish-DeploymentLog }
      }
      Write-DesktopDecision -Mode "本机清单直写（复用现有构建，更新 $($plan.changed) / $($plan.files) 项）" -Reason $directEligibility.Reason
      Write-DeploymentLog "[desktop:auto] 复用构建，按绑定清单直写 $($plan.changed) 项"
    }
  }
  if ($needsRebuild) {
    Write-DesktopDecision -Mode '本机快速构建 + 清单直写' -Reason $rebuildReason
    Write-DeploymentLog "[desktop:auto] 本机候选需要重建：$rebuildReason"
    # Run the build before UAC so compilation stays in normal user context and
    # build failures or zero-diff results never trigger an unnecessary UAC prompt.
    if (-not $isElevated) {
      if (@(Get-DesktopInstallationProcesses -InstallDir $installDir).Count -gt 0) {
        Assert-DesktopMaintenanceAvailable -InstallDir $installDir -ConfigRoot $configRoot
      } else { Assert-DesktopDeploymentStopped -InstallDir $installDir -ConfigRoot $configRoot }
      Write-Host '[1/6] 正在本机编译与暂存最新构建（无需管理员权限）...' -ForegroundColor Cyan
      Write-DeploymentLog '[1/6] 正在本机编译与暂存最新构建 ...'
      Push-Location $root
      $previousForce = $env:AICS_DESKTOP_FORCE_BUILD
      try {
        if ($ForceBuild) { $env:AICS_DESKTOP_FORCE_BUILD = '1' }
        Invoke-DesktopNpm -Arguments @('run','build:tauri','--','--local','--direct') -PrettyConsole
      } finally { $env:AICS_DESKTOP_FORCE_BUILD = $previousForce; Pop-Location }
      $plan = Invoke-BoundDirectDeployment -Action prepare -Id ([Guid]::NewGuid().ToString('N'))
      if ($plan.mode -eq 'build') { throw "本机候选核验失败：$($plan.reason)" }
      $DirectPlanId = $plan.id
      $DirectPlanSha256 = $plan.sha256
      $missingLedger = -not (Test-Path -LiteralPath (Join-Path $installDir '.huiyu-installed-resources.json') -PathType Leaf)
      if ($plan.mode -eq 'current' -and -not ($missingLedger -or $SyncLocalModels -or $AdoptProjectCatalog -or $referenceIdList.Count)) {
        Write-Host '  ✓ 构建完成后与已安装文件完全一致，无需提权写入。' -ForegroundColor Green
        try { $null = Complete-CurrentDeployment; exit 0 } finally { Remove-DirectDeploymentPlan; Publish-DeploymentLog }
      }
      Write-Host "  ✓ 构建完成，检测到 $($plan.changed) / $($plan.files) 项文件变化，准备写入安装目录。" -ForegroundColor Green
      Write-DeploymentLog "[desktop:auto] 构建完成，按绑定清单直写 $($plan.changed) / $($plan.files) 项"
    }
  }
  $DeploymentPlanApplied = $true
}

# Detect before UAC: an already-current install or a missing full installer must
# not require elevation, and the selected mode is passed to the child unchanged.
if (-not ($DirectInstall -or $UseInstaller -or $ResourcesOnly -or $StartupRepair -or $SkipBuild -or $ForceBuild -or $DeploymentPlanApplied -or $InstallerPath)) {
  $QuietInstall = $true
  $Cleanup = $true
  $bindingScripts = @('desktop-build-binding.js', 'desktop-installer-binding.js')
  if ($bindingScripts | Where-Object { -not (Test-Path -LiteralPath (Join-Path $root "scripts\lib\$_")) }) {
    Write-Host '  · 生成部署检测运行时 ...' -ForegroundColor DarkGray
    Push-Location $root
    try { Invoke-DesktopNpm -Arguments @('run','build:runtime') -PrettyConsole:(-not $DeferRestart) } finally { Pop-Location }
  }
  if ($installationState -eq 'fresh' -or $installationState -eq 'repair') {
    $InstallerPath = Select-CurrentFullInstaller -State $stateText
    $UseInstaller = $true
    Write-DesktopDecision -Mode '发行完整包安装 / 修复' -Reason $directEligibility.Reason
    Write-DeploymentLog '[desktop:auto] 选择：发行完整包安装/修复'
  } else {
    Write-Host '  · 正在核对源码、构建和已安装文件 ...' -ForegroundColor DarkGray
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
    $combinedReason = if ($directEligibility.Reason) { "$($directEligibility.Reason)；$($plan.reason)" } else { [string]$plan.reason }
    Write-DesktopDecision -Mode $modeText -Reason $combinedReason
    Write-DeploymentLog "[desktop:auto] 选择：$modeText；原因：$combinedReason"
    switch ($plan.mode) {
      'current' {
        $missingLedger = (Test-Path -LiteralPath (Join-Path $gatewayDir 'bundled-resource-inventory.json')) -and
          -not (Test-Path -LiteralPath (Join-Path $installDir '.huiyu-installed-resources.json'))
        if ($missingLedger -or $SyncLocalModels -or $AdoptProjectCatalog -or $referenceIdList.Count) {
          Write-Host '  ▸ 程序已是最新，转为资源同步以执行指定的维护操作。' -ForegroundColor Cyan
          $ResourcesOnly = $true
          $SkipBuild = $true
          $QuietInstall = $false
        } else {
          try { $null = Complete-CurrentDeployment; exit 0 } finally { Publish-DeploymentLog }
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
} elseif (-not $DeferRestart -and -not $DirectInstall) {
  $manualMode = if ($StartupRepair) { '启动修复（快捷方式与 WebView 缓存）' }
    elseif ($ResourcesOnly) { '仅同步静态资源' }
    elseif ($UseInstaller) { '使用指定安装包部署' }
    elseif ($ForceBuild) { '强制重新构建并安装' }
    elseif ($SkipBuild) { '复用已有构建并封装安装' }
    else { '自定义参数部署' }
  Write-DesktopDecision -Mode $manualMode -Reason '按传入命令行参数执行'
}

if ($StartupRepair -and ($UseInstaller -or $AdoptProjectCatalog)) { throw '-StartupRepair 不能与 -UseInstaller 或 -AdoptProjectCatalog 同时使用' }
if ($ResourcesOnly -and $UseInstaller) { throw '-ResourcesOnly 与 -UseInstaller 不能同时使用' }
$buildUpgrade = -not ($DirectInstall -or $UseInstaller -or $ResourcesOnly -or $StartupRepair)
if ($ForceBuild -and ((-not $buildUpgrade -and -not $DirectInstall) -or $SkipBuild)) { throw '-ForceBuild 仅用于默认部署，不能与显式复用/修复模式组合' }
$installWithPackage = $UseInstaller -or $buildUpgrade
if ($QuietInstall -and -not ($installWithPackage -or $DirectInstall)) { throw '-QuietInstall 不适用于资源同步或修复' }
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
  $verification = & node @bindingArgs 2>&1
  if ($LASTEXITCODE -ne 0) { throw "DESKTOP_INSTALLER_BINDING: 固定安装包、校验清单或已安装文件不匹配。$($verification -join ' ')" }
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
  $argList += @('-InstallDir', "`"$installDir`"")
  # Start-Process -Wait includes descendants, so the restarted client would
  # keep this wrapper alive. Wait only for the elevated deployment process.
  $logReader = $null
  $elevatedProcess = $null
  $lastFailureLine = ''
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
      & $drainLog
    } while (-not $finished)
    Start-Sleep -Milliseconds 100
    & $drainLog
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
    Write-DesktopSummary -Kind 'busy' -Title '当前工作区已有另一个部署任务正在执行' -Details @('请等待上一个部署窗口完成后再重试。')
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
  $lockPath = Resolve-DesktopChildPath -Root $root -Relative 'runtime\desktop-deploy.lock'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $lockPath) | Out-Null
  $deploymentLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
} catch [IO.IOException] {
  if (($_.Exception.GetBaseException().HResult -band 0xffff) -notin @(32,33)) { throw }
  Write-DeploymentLog 'DESKTOP_DEPLOY_BUSY: 当前工作区已有部署。'
  Write-Host 'DESKTOP_DEPLOY_BUSY: 当前工作区已有部署。' -ForegroundColor Yellow
  exit 73
}
$transcriptStarted = $false
$installMutex = $null
$installMutexHeld = $false
try {
Start-Transcript -LiteralPath $deploymentLogPath -Append | Out-Null
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
  if ($DirectInstall) { $null = Invoke-BoundDirectDeployment -Action validate -Id $DirectPlanId -Sha256 $DirectPlanSha256; return }
  if ($installWithPackage) { Assert-FixedInstaller; return }
  & node (Join-Path $root 'scripts\lib\desktop-build-binding.js') $root $InstallerPath
  if ($LASTEXITCODE -ne 0) { throw 'DESKTOP_BUILD_BINDING: 源码/资源/安装包与构建回执不匹配；请重新完整构建。' }
  $buildReceipt = Get-Content -LiteralPath (Join-Path $root 'runtime\delivery-evidence\desktop-build-binding.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $buildProfile = if ($buildReceipt.buildProfile) { $buildReceipt.buildProfile } else { 'release' }
  if ($buildProfile -notin @('release', 'desktop-local')) { throw 'DESKTOP_BUILD_BINDING: 未知构建档位。' }
  $script:hostExecutable = Join-Path $root "desktop-tauri\src-tauri\target\$buildProfile\ai-cg-studio-desktop.exe"
}
if ($DirectInstall) {
  Write-Host $(if ($DirectPlanId) { '[1/6] 核验本机直写部署清单 ...' } else { '[1/6] 准备本机清单直写 ...' }) -ForegroundColor Cyan
  if (-not $DirectPlanId) {
    if ($SkipBuild) { throw '-SkipBuild 需要已经核验的本机候选。' }
    Push-Location $root
    $previousForce = $env:AICS_DESKTOP_FORCE_BUILD
    try {
      if ($ForceBuild) { $env:AICS_DESKTOP_FORCE_BUILD = '1' }
      Invoke-DesktopNpm -Arguments @('run','build:tauri','--','--local','--direct') -PrettyConsole:(-not $DeferRestart)
    } finally { $env:AICS_DESKTOP_FORCE_BUILD = $previousForce; Pop-Location }
    $plan = Invoke-BoundDirectDeployment -Action prepare -Id ([Guid]::NewGuid().ToString('N'))
    if ($plan.mode -eq 'build') { throw "本机候选核验失败：$($plan.reason)" }
    $DirectPlanId = $plan.id
    $DirectPlanSha256 = $plan.sha256
  }
} elseif ($buildUpgrade) {
  Write-Host '[1/6] 准备本机快速构建与轻量升级包 ...' -ForegroundColor Cyan
  $candidate = $null
  if (-not $SkipBuild -and -not $ForceBuild -and -not $DeploymentPlanApplied) {
    if (-not (Test-Path -LiteralPath (Join-Path $root 'scripts\lib\desktop-build-binding.js'))) {
      Push-Location $root
      try { Invoke-DesktopNpm -Arguments @('run','build:runtime') -PrettyConsole:(-not $DeferRestart) } finally { Pop-Location }
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
      Invoke-DesktopNpm -Arguments $upgradeArgs -PrettyConsole:(-not $DeferRestart)
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
  try { Invoke-DesktopNpm -Arguments @('run','build:tauri','--','--local') -PrettyConsole:(-not $DeferRestart) }
  finally { Pop-Location }
} else { Write-Host $(if ($UseInstaller) { '[1/6] 复用本次固定安装包' } else { '[1/6] 复用当前已绑定构建' }) -ForegroundColor DarkGray }
if ($DirectInstall) {
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { $installKey = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($installDir.ToLowerInvariant()))).Replace('-', '') }
  finally { $hasher.Dispose() }
  $installMutex = New-Object Threading.Mutex($false, "Global\HuiyuDesktopLocalDeploy_$installKey")
  try { $installMutexHeld = $installMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $installMutexHeld = $true }
  if (-not $installMutexHeld) { throw 'DESKTOP_DEPLOY_BUSY: 该安装目录已有直写部署。' }
}
Assert-CurrentBuildBinding
if (-not ($installWithPackage -or $DirectInstall)) { Assert-DesktopRuntimeMatches -StageGateway $stageGateway -InstallDir $installDir -HostExecutable $hostExecutable }
Write-DesktopDuration '构建准备与首次校验'
Stop-DesktopForDeployment -InstallDir $installDir -ConfigRoot $configRoot
Write-DesktopDuration '应用维护退出'
Write-Host '[2/6] 宿主与自有 Rust 网关已退出，工作区锁已释放' -ForegroundColor DarkGray
if (-not $DirectInstall) { Assert-CurrentBuildBinding }
if (-not ($installWithPackage -or $DirectInstall)) { Assert-DesktopRuntimeMatches -StageGateway $stageGateway -InstallDir $installDir -HostExecutable $hostExecutable }
Write-DesktopDuration '写入前校验'
Write-Host '[3/6] 安装边界核验完成' -ForegroundColor DarkGray
if ($DirectInstall) {
  Write-Host '[4/6] 原子替换绑定清单中的差异文件 ...' -ForegroundColor Cyan
  Assert-DesktopDeploymentStopped -InstallDir $installDir -ConfigRoot $configRoot
  $applied = Invoke-BoundDirectDeployment -Action apply -Id $DirectPlanId -Sha256 $DirectPlanSha256
  Write-Host "[desktop:direct] 替换 $($applied.changed) 项，安装后校验 $($applied.files) 项。"
} elseif ($installWithPackage) {
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
    foreach ($name in @('resource-layers.json','rust-runtime-build.json','native-dependencies.windows-x64.json','bundled-resource-inventory.json')) {
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
if (-not $DirectInstall) {
  Assert-CurrentBuildBinding
  if ($installWithPackage) { Assert-FixedInstaller -Installed }
  else { Assert-DesktopRuntimeMatches -StageGateway $stageGateway -InstallDir $installDir -HostExecutable $hostExecutable }
}
if (-not $StartupRepair) {
  Invoke-DesktopResourceCleanup -Root $root -InstallDir $installDir -StageGateway $stageGateway -InstalledFromPackage:$installWithPackage -DirectFromBuild:$DirectInstall -InstallerPath $InstallerPath
}
Write-DesktopDuration '安装后校验'
if (-not $StartupRepair) {
  $catalogArguments = @((Join-Path $root 'scripts\lib\desktop-catalog-update.js'), $gatewayDir, (Join-Path $configRoot 'gateway'))
  if ($AdoptProjectCatalog) { $catalogArguments += '--adopt-project-catalog' }
  $previousPreference = $ErrorActionPreference
  $catalogRaw = @()
  try {
    $ErrorActionPreference = 'Continue'
    $catalogRaw = @(& node @catalogArguments 2>&1 | ForEach-Object { $_.ToString() })
    $catalogExitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousPreference }
  if ($catalogExitCode -ne 0) {
    foreach ($line in $catalogRaw) { Write-Host "[desktop:detail] $line" }
    throw '内容库更新未完成；请检查上述原始错误及备份，不能仅凭素材安装成功判断人物已更新。'
  }
  $catalogSummary = $null
  try {
    $parsedCatalog = ($catalogRaw -join "`n") | ConvertFrom-Json
    if ($parsedCatalog.firstLaunch) {
      $catalogSummary = '首次启动将自动初始化个人内容库'
    } elseif ($parsedCatalog.adoptedProjectCatalog) {
      $catalogSummary = "已切换为项目内容库快照（共 $($parsedCatalog.records) 条，原库已备份）"
    } else {
      $changedCount = [int]$parsedCatalog.changed
      $preservedCount = if ($parsedCatalog.preservedLocal) { @($parsedCatalog.preservedLocal).Count } else { 0 }
      $keptNewerCount = if ($parsedCatalog.keptNewer) { @($parsedCatalog.keptNewer).Count } else { 0 }
      $notes = @()
      if ($preservedCount -gt 0) { $notes += "保留本机修改 $preservedCount 项" }
      if ($keptNewerCount -gt 0) { $notes += "保留较新记录 $keptNewerCount 项" }
      $suffix = if ($notes.Count) { "（$($notes -join '，')）" } else { '' }
      $catalogSummary = if ($changedCount -gt 0) { "已同步内容库更新 $changedCount 项$suffix" } else { "内容库已是最新$suffix" }
    }
  } catch {
    $catalogSummary = '内容库同步已完成'
  }
  Write-Host "[desktop:catalog] $catalogSummary" -ForegroundColor Green
  Write-DesktopDuration '内容快照导入与核对'
  if ($referenceIdList.Count) {
    Assert-ReferenceSyncAvailable
    $referenceSource = Resolve-DesktopChildPath -Root $root -Relative ('runtime\desktop-reference-sync\' + [Guid]::NewGuid().ToString('N'))
    $referenceShards = Join-Path $referenceSource 'references'
    New-Item -ItemType Directory -Path $referenceShards -Force | Out-Null
    $manifestPath = Resolve-DesktopChildPath -Root $gatewayDir -Relative 'data\references\manifest.json'
    $referenceManifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($id in $referenceIdList) {
      if ($id -cnotin $referenceManifest.characterIds) { throw "REFERENCE_ID_UNKNOWN: 安装资料中没有角色 $id。" }
      $source = Resolve-DesktopChildPath -Root $gatewayDir -Relative "data\references\$id.json"
      Copy-Item -LiteralPath $source -Destination (Join-Path $referenceShards "$id.json")
    }
    $contentData = Join-Path $configRoot 'gateway\content\data'
    & node (Join-Path $root 'scripts\maintenance\sync-desktop-content.js') "--source=$referenceSource" "--content-root=$contentData" --apply
    if ($LASTEXITCODE -ne 0) { throw '个人参考分片同步未完成；请检查上述错误及备份。' }
    Write-DesktopDuration '个人参考分片同步'
  }
}
Write-Host '[5/6] 安装完整性校验通过（宿主、Rust 网关与原生库哈希一致）' -ForegroundColor DarkGray
if ($StartupRepair) {
  $webviewBase = Join-Path $env:LOCALAPPDATA 'com.aics.studio\EBWebView\Default'
  foreach ($name in @('Cache','Code Cache','GPUCache')) {
    $target = Resolve-DesktopChildPath -Root $webviewBase -Relative $name
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Write-Host '[desktop:cache] 已执行启动修复缓存清理。' -ForegroundColor DarkGray
}
$directStarted = $null
if ($NoRestart) {
  Write-Host '[6/6] 按 -NoRestart 保持退出' -ForegroundColor DarkGray
} elseif ($DeferRestart) {
  Write-Host '[6/6] 文件写入完成，交由普通用户会话启动桌面端 ...' -ForegroundColor DarkGray
} else {
  $directStarted = Start-DesktopClientAndWait
}
Write-DesktopDuration '启动确认'
Write-Host ('[desktop:timing] 部署总耗时: {0:F2}s' -f $deployTimer.Elapsed.TotalSeconds)
try { Remove-DirectDeploymentPlan; Remove-StaleDeploymentCopies }
catch { Write-Host "[desktop:cleanup] 清理历史副本失败：$($_.Exception.Message)" -ForegroundColor Yellow }
if (-not $DeferRestart) {
  $elapsedFinal = '{0:F1}s' -f $script:overallTimer.Elapsed.TotalSeconds
  $details = @("安装目录：$installDir")
  if ($directStarted) { $details += "运行状态：$($directStarted.visible)（PID $($directStarted.hostPid)）" }
  elseif ($NoRestart) { $details += '已按 -NoRestart 保持桌面端关闭' }
  Write-DesktopSummary -Kind 'success' -Title "绘遇桌面端部署完成（总耗时 $elapsedFinal）" -Details $details
}
} catch {
  $script:elevatedFailureLogged = $true
  Write-Host "[desktop:failed] $($_.Exception.Message)" -ForegroundColor Red
  if ($installWithPackage -and $InstallerManifestSha256) {
    Write-Host "[desktop:auto] 已固定的安装包仍可复用：$InstallerPath"
    Write-Host '[desktop:auto] 修正上述原因后，可用 -UseInstaller -InstallerPath 指定此包继续，无需重复构建。'
  }
  throw
} finally {
  try { if ($transcriptStarted) { Stop-Transcript | Out-Null; Publish-DeploymentLog } }
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
  Fail-DesktopDeployment -Message $_.Exception.Message -ExitCode 1 -Hints $hints
}

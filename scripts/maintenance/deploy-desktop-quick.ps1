# AI-CG-Studio 桌面端部署 —— 唯一入口
#
# 默认核验后复用升级包/原生构建，必要时以 desktop-local 重建；不携带 WebView2/保留素材。
# -ResourcesOnly 仅同步已绑定静态资源，要求安装 EXE/DLL 与候选一致。
# -UseInstaller 复用已绑定升级包；首次安装/修复须显式 -InstallerPath 指向发行完整包。
#
# 常用组合：
#   双击 deploy-desktop.bat                 构建并安装本机升级包
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
  [string]$InstallDir,
  [string]$InstallerPath,
  [string]$InstallerManifestSha256
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $InstallDir) {
  $locations = @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AI-CG-Studio',
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AI-CG-Studio',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\AI-CG-Studio') |
    ForEach-Object { (Get-ItemProperty -LiteralPath $_ -ErrorAction SilentlyContinue).InstallLocation } |
    Where-Object { $_ } | ForEach-Object { $_.Trim('"') } | Select-Object -Unique
  if (@($locations).Count -gt 1) { throw '发现多个安装目录，请用 -InstallDir 指定要修复的安装。' }
  $InstallDir = if ($locations) { @($locations)[0] } else { 'C:\Program Files\AI-CG-Studio' }
}
$installDir = [IO.Path]::GetFullPath($InstallDir)
$gatewayDir = Join-Path $installDir 'gateway'
if ($StartupRepair -and $UseInstaller) { throw '-StartupRepair 与 -UseInstaller 不能同时使用' }
if ($ResourcesOnly -and $UseInstaller) { throw '-ResourcesOnly 与 -UseInstaller 不能同时使用' }
$buildUpgrade = -not ($UseInstaller -or $ResourcesOnly -or $StartupRepair)
if ($ForceBuild -and (-not $buildUpgrade -or $SkipBuild)) { throw '-ForceBuild 仅用于默认部署，不能与显式复用/修复模式组合' }
$installWithPackage = $UseInstaller -or $buildUpgrade
if ($QuietInstall -and -not $installWithPackage) { throw '-QuietInstall 仅用于安装包部署' }
if ($InstallerPath -and -not $UseInstaller) { throw '-InstallerPath 仅可与 -UseInstaller 一起使用' }
$setup = $null
if ($UseInstaller) {
  $setup = if ($InstallerPath) { Get-Item -LiteralPath $InstallerPath -ErrorAction Stop } else {
    $version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    Get-ChildItem -Path (Join-Path $root 'runtime\desktop-updates') -Filter "*_${version}_x64*-upgrade-setup.exe" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
  }
  if (-not $setup) { throw '没有当前版本的升级包；去掉 -UseInstaller 先构建升级包。首次安装/修复请用 -InstallerPath 明确选择发行完整包。' }
  if ($setup.PSIsContainer -or $setup.Extension -ine '.exe') { throw 'InstallerPath 必须指向已验收的 EXE 安装包' }
  # Keep the exact candidate across UAC, even if another build finishes meanwhile.
  $InstallerPath = $setup.FullName
}

. (Join-Path $root 'scripts\lib\desktop-deploy-guard.ps1')
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
$configRoot = Join-Path $env:APPDATA 'com.aics.studio'
# Read-only preflight: UAC denial, missing payload or build failure must leave
# the user's running application untouched. Actual drain occurs before writes.
if (@(Get-DesktopInstallationProcesses -InstallDir $installDir).Count -gt 0) {
  Assert-DesktopMaintenanceAvailable -InstallDir $installDir -ConfigRoot $configRoot
} else { Assert-DesktopDeploymentStopped -InstallDir $installDir -ConfigRoot $configRoot }

# 源端已删除、但增量部署（Copy-Item 只合并不删除）会在安装目录永久堆积的历史目录。
# 2026-08-29：character-references（~1.2G）已迁出项目到 AI 工作区，安装目录那份成冗余副本。
# 2026-09-30：旧场景单文件（nene-core / nene-after-story / natsume-core）在仓库中已被
# 数字分片取代，但安装目录里的 2026-08-27 残留会随「安装目录 -> 个人内容目录」的复制
# 回流，造成「单文件与批次文件并存」，使维护接口拒绝服务（见 docs/desktop-deployment.md）。
# 凡是「源端删除型」的迁移，都必须在这里登记，否则增量部署永远清不掉。
$STALE_ASSETS = @(
  'assets\character-references',
  'data\scenes\nene-core.json', 'data\scenes\nene-core.json.br', 'data\scenes\nene-core.json.gz',
  'data\scenes\nene-after-story.json', 'data\scenes\nene-after-story.json.br', 'data\scenes\nene-after-story.json.gz',
  'data\scenes\natsume-core.json', 'data\scenes\natsume-core.json.br', 'data\scenes\natsume-core.json.gz'
)

# 提权：注意要把已传入的参数一起带过去，否则 UAC 后的新进程会丢掉它们
# （旧版这里只传脚本路径，导致 -SkipBuild 静默失效、白白重跑一次 build）。
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host '需要管理员权限，正在弹出 UAC 授权窗口，请点击"是"' -ForegroundColor Yellow
  $argList = @('-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
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
  if ($SyncLocalModels) { $argList += '-SyncLocalModels' }
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
    $elevatedProcess = Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList ($argList -join ' ') -PassThru
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
  if (-not $SkipBuild -and -not $ForceBuild) {
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
  } else { Write-Host $(if ($ForceBuild) { '[desktop:auto] 按 -ForceBuild 重建' } else { '[desktop:auto] 按 -SkipBuild 复用原生构建并重新封装' }) }
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
  $setupProcess = if ($QuietInstall) {
    Start-Process -FilePath $setup.FullName -ArgumentList "/S /D=$installDir" -WindowStyle Hidden -Wait -PassThru
  } else { Start-Process -FilePath $setup.FullName -Wait -PassThru }
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
  & node (Join-Path $root 'scripts\lib\desktop-catalog-update.js') $gatewayDir (Join-Path $configRoot 'gateway')
  if ($LASTEXITCODE -ne 0) { throw '内容库更新未完成；个人修改保留。请检查快照或合并冲突后再部署，不能仅凭素材安装成功判断人物已更新。' }
  Write-DesktopDuration '内容快照导入与核对'
}
Write-Host '[5/6] Rust EXE、宿主和两份 native DLL 与候选哈希一致；不冒充模型验收' -ForegroundColor DarkGray
$webviewBase = Join-Path $env:LOCALAPPDATA 'com.aics.studio\EBWebView\Default'
foreach ($name in @('Cache','Code Cache','GPUCache')) {
  $target = Resolve-DesktopChildPath -Root $webviewBase -Relative $name
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue }
}
if (-not $NoRestart) {
  Write-Host '[6/6] 启动桌面端 ...' -ForegroundColor Cyan
  Start-Process explorer.exe -ArgumentList "`"$installDir\ai-cg-studio-desktop.exe`""
  $startup = Wait-DesktopDeploymentReady -InstallDir $installDir -ConfigRoot $configRoot
  Write-Host "宿主与所属 Rust 网关已就绪（PID $($startup.hostPid)）" -ForegroundColor Green
} else { Write-Host '[6/6] 按 -NoRestart 保持退出' -ForegroundColor DarkGray }
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

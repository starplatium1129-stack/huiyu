# AI-CG-Studio 桌面端部署 —— 唯一入口
#
# 两种模式（二选一，默认增量）：
#   增量部署（默认）  把新鲜的 已绑定的 data/dist/assets/docs/tools 复制到已安装网关，秒级生效。
#                    仅限 EXE/DLL 完全相同的静态资源；Rust 与打包 UI 改动必须完整安装。
#   -UseInstaller    运行 runtime\desktop-updates 下最新的完整安装包（用户在向导里点几下）。
#                    适用于 Rust runtime、DLL、宿主或打包 UI 变化及全新安装。
#
# 常用组合：
#   双击 deploy-desktop.bat                 增量部署（含清理历史残留 + 验证）
#   deploy-desktop.bat -SkipBuild           已手动 build 过，跳过构建
#   deploy-desktop.bat -UseInstaller        用完整安装包安装（本次要更新的依赖在包里）
#   deploy-desktop.bat -NoRestart           部署后不自动启动
#
# 参数说明：
#   -SkipBuild     复用匹配当前源码的桌面构建绑定
#   -Cleanup       删除「源端已删除」的历史残留目录（见下 $STALE_ASSETS）
#   -UseInstaller  跑完整安装包，不做增量复制
#   -NoRestart     结束后不启动桌面端
param(
  [switch]$SyncLocalModels,
  [switch]$SkipBuild,
  [switch]$Cleanup,
  [switch]$UseInstaller,
  [switch]$QuietInstall,
  [switch]$NoRestart,
  [switch]$StartupRepair,
  [string]$InstallDir,
  [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'
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
if ($QuietInstall -and -not $UseInstaller) { throw '-QuietInstall 仅可与 -UseInstaller 一起使用' }
if ($InstallerPath -and -not $UseInstaller) { throw '-InstallerPath 仅可与 -UseInstaller 一起使用' }
$setup = $null
if ($UseInstaller) {
  $setup = if ($InstallerPath) { Get-Item -LiteralPath $InstallerPath -ErrorAction Stop } else {
    Get-ChildItem -Path (Join-Path $root 'runtime\desktop-updates') -Filter '*-setup.exe' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
  }
  if (-not $setup) { throw 'runtime\desktop-updates 下没有找到安装包，请先 npm run package:tauri' }
  if ($setup.PSIsContainer -or $setup.Extension -ine '.exe') { throw 'InstallerPath 必须指向已验收的 EXE 安装包' }
  # Keep the exact candidate across UAC, even if another build finishes meanwhile.
  $InstallerPath = $setup.FullName
}

. (Join-Path $root 'scripts\lib\desktop-deploy-guard.ps1')
$configRoot = Join-Path $env:APPDATA 'com.aics.studio'
# Read-only preflight: UAC denial, missing payload or build failure must leave
# the user's running application untouched. Actual drain occurs before writes.
if (@(Get-DesktopInstallationProcesses -InstallDir $installDir).Count -gt 0) {
  Get-DesktopMaintenanceIdentity -InstallDir $installDir -ConfigRoot $configRoot | Out-Null
} else { Assert-DesktopDeploymentStopped -InstallDir $installDir -ConfigRoot $configRoot }

# 源端已删除、但增量部署（Copy-Item 只合并不删除）会在安装目录永久堆积的历史目录。
# 2026-08-29：character-references（~1.2G）已迁出项目到 AI 工作区，安装目录那份成冗余副本。
# 凡是「源端删除型」的迁移，都必须在这里登记，否则增量部署永远清不掉。
$STALE_ASSETS = @('assets\character-references')

# 提权：注意要把已传入的参数一起带过去，否则 UAC 后的新进程会丢掉它们
# （旧版这里只传脚本路径，导致 -SkipBuild 静默失效、白白重跑一次 build）。
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host '需要管理员权限，正在弹出 UAC 授权窗口，请点击"是"' -ForegroundColor Yellow
  $argList = @('-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  if ($SkipBuild)    { $argList += '-SkipBuild' }
  if ($Cleanup)      { $argList += '-Cleanup' }
  if ($UseInstaller) { $argList += '-UseInstaller' }
  if ($InstallerPath) { $argList += @('-InstallerPath', "`"$InstallerPath`"") }
  if ($QuietInstall) { $argList += '-QuietInstall' }
  if ($NoRestart)    { $argList += '-NoRestart' }
  if ($StartupRepair) { $argList += '-StartupRepair' }
  if ($SyncLocalModels) { $argList += '-SyncLocalModels' }
  $argList += @('-InstallDir', "`"$installDir`"")
  $elevatedProcess = Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList ($argList -join ' ') -Wait -PassThru
  exit $elevatedProcess.ExitCode
}

Start-Transcript -Path (Join-Path $root 'runtime\desktop-deploy-last.log') -Append | Out-Null
$stageGateway = Join-Path $root 'desktop-tauri\src-tauri\resources\gateway'
$hostExecutable = Join-Path $root 'desktop-tauri\src-tauri\target\release\ai-cg-studio-desktop.exe'
# Validate selected source/build/distribution before drain and before restart.
function Assert-CurrentBuildBinding {
  & node (Join-Path $root 'scripts\lib\desktop-build-binding.js') $root $InstallerPath
  if ($LASTEXITCODE -ne 0) { throw 'DESKTOP_BUILD_BINDING: 源码/资源/安装包与构建回执不匹配；请重新完整构建。' }
}
if (-not $UseInstaller -and -not $SkipBuild) {
  Write-Host '[1/6] 构建并绑定 Rust 桌面候选 ...' -ForegroundColor Cyan
  Push-Location $root
  try { npm run build:tauri; if ($LASTEXITCODE -ne 0) { throw 'Desktop candidate build failed' } }
  finally { Pop-Location }
} else { Write-Host '[1/6] 复用当前已绑定构建' -ForegroundColor DarkGray }
Assert-CurrentBuildBinding
if (-not $UseInstaller) { Assert-DesktopRuntimeMatches -StageGateway $stageGateway -InstallDir $installDir -HostExecutable $hostExecutable }
Stop-DesktopForDeployment -InstallDir $installDir -ConfigRoot $configRoot
Write-Host '[2/6] 宿主与自有 Rust 网关已退出，工作区锁已释放' -ForegroundColor DarkGray
Assert-CurrentBuildBinding
if (-not $UseInstaller) { Assert-DesktopRuntimeMatches -StageGateway $stageGateway -InstallDir $installDir -HostExecutable $hostExecutable }
if ($Cleanup) {
  foreach ($relative in $STALE_ASSETS) {
    $target = Resolve-DesktopChildPath -Root $gatewayDir -Relative $relative
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  }
}
Write-Host '[3/6] 安装边界核验完成' -ForegroundColor DarkGray
if ($UseInstaller) {
  Write-Host '[4/6] 运行已绑定的完整安装包 ...' -ForegroundColor Cyan
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
Assert-CurrentBuildBinding
Assert-DesktopRuntimeMatches -StageGateway $stageGateway -InstallDir $installDir -HostExecutable $hostExecutable
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
Stop-Transcript | Out-Null

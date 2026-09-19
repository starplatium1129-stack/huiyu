# AI-CG-Studio 桌面端部署 —— 唯一入口
#
# 两种模式（二选一，默认增量）：
#   增量部署（默认）  把新鲜的 dist/data/assets/routes/... 复制到已安装网关，秒级生效。
#                    适用于前端代码改动，也是日常开发最常用的方式。
#   -UseInstaller    运行 runtime\desktop-updates 下最新的完整安装包（用户在向导里点几下）。
#                    适用于 gateway 依赖变化、Rust 壳改动或全新安装。
#
# 常用组合：
#   双击 deploy-desktop.bat                 增量部署（含清理历史残留 + 验证）
#   deploy-desktop.bat -SkipBuild           已手动 build 过，跳过构建
#   deploy-desktop.bat -UseInstaller        用完整安装包安装（本次要更新的依赖在包里）
#   deploy-desktop.bat -NoRestart           部署后不自动启动
#
# 参数说明：
#   -SkipBuild     跳过前端构建（npm run build）
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
  [string]$InstallDir
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
  if ($QuietInstall) { $argList += '-QuietInstall' }
  if ($NoRestart)    { $argList += '-NoRestart' }
  if ($StartupRepair) { $argList += '-StartupRepair' }
  if ($SyncLocalModels) { $argList += '-SyncLocalModels' }
  $argList += @('-InstallDir', "`"$installDir`"")
  if ($QuietInstall) {
    $argList = @($argList | Where-Object { $_ -ne '-NoExit' })
    Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList ($argList -join ' ')
  } else {
    Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList ($argList -join ' ')
  }
  exit 0
}

if ($QuietInstall -and -not $UseInstaller) { throw '-QuietInstall 仅可与 -UseInstaller 一起使用' }
Start-Transcript -Path (Join-Path $root 'runtime\desktop-deploy-last.log') -Append | Out-Null

# Narrow repair for 1.6.0: no dependency, executable or user-data replacement.
if ($StartupRepair) {
  if (-not (Test-Path -LiteralPath (Join-Path $gatewayDir 'server.js'))) { throw "无效安装目录: $installDir" }
  $destination = Join-Path $gatewayDir 'docs'
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  Copy-Item -Path (Join-Path $root 'docs\*') -Destination $destination -Recurse -Force
  $icon = Join-Path $installDir 'huiyu-icon.ico'
  Copy-Item -LiteralPath (Join-Path $root 'desktop-tauri\src-tauri\icons\icon.ico') -Destination $icon -Force
  $shell = New-Object -ComObject WScript.Shell
  foreach ($directory in @([Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('Desktop'),
      [Environment]::GetFolderPath('CommonPrograms'), [Environment]::GetFolderPath('Programs'))) {
    if (-not $directory -or -not (Test-Path -LiteralPath $directory)) { continue }
    Get-ChildItem -LiteralPath $directory -Filter '*.lnk' -File -Recurse | ForEach-Object {
      $shortcut = $shell.CreateShortcut($_.FullName)
      if ($shortcut.TargetPath -ieq (Join-Path $installDir 'ai-cg-studio-desktop.exe')) {
        $shortcut.IconLocation = "$icon,0"
        $shortcut.Save()
      }
    }
  }
  Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class HuiyuShell { [DllImport("shell32.dll")] public static extern void SHChangeNotify(uint e, uint f, System.IntPtr a, System.IntPtr b); }'
  [HuiyuShell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
  Get-Process -Name 'ai-cg-studio-desktop' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -ieq (Join-Path $installDir 'ai-cg-studio-desktop.exe') } | Stop-Process
  if (-not $NoRestart) { Start-Process explorer.exe -ArgumentList "`"$installDir\ai-cg-studio-desktop.exe`"" }
  Write-Host "启动资源和快捷方式图标已修复: $installDir"
  Stop-Transcript | Out-Null
  exit 0
}

# 安装包里已经带好了构建产物，用它安装时无需本地构建
if ($UseInstaller) { $SkipBuild = $true }

if (-not $UseInstaller -and -not (Test-Path $gatewayDir)) {
  Write-Error "安装目录不存在: $gatewayDir（先用 -UseInstaller 完整安装一次）"
  exit 1
}

# ---------------------------------------------------------------- [1] 构建
if (-not $SkipBuild) {
  Write-Host '[1/6] npm run build ...' -ForegroundColor Cyan
  Push-Location $root
  npm run build
  if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error 'build failed'; exit 1 }
  Pop-Location
} else {
  Write-Host '[1/6] 跳过构建（-SkipBuild / 安装包模式）' -ForegroundColor DarkGray
}

# ---------------------------------------------------------- [2] 停应用
$appProcs = Get-Process -Name 'ai-cg-studio-desktop' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -ieq (Join-Path $installDir 'ai-cg-studio-desktop.exe') }
$sidecar = Get-Process -Name 'node' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -ieq (Join-Path $installDir 'node.exe') }
if ($appProcs -or $sidecar) {
  Write-Host '[2/6] 停止本安装目录的应用与网关 ...' -ForegroundColor Cyan
  $appProcs | Stop-Process -Force -ErrorAction SilentlyContinue
  $sidecar | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
} else {
  Write-Host '[2/6] 应用未在运行' -ForegroundColor DarkGray
}

# ------------------------------------------------- [3] 清理源端删除型残留
if ($Cleanup) {
  Write-Host '[3/6] 清理源端已删除的历史残留 ...' -ForegroundColor Cyan
  $freedTotal = 0
  foreach ($rel in $STALE_ASSETS) {
    $target = Join-Path $gatewayDir $rel
    if (-not (Test-Path $target)) { continue }
    $files = @(Get-ChildItem -Path $target -Recurse -File -ErrorAction SilentlyContinue)
    $mb = [math]::Round((($files | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)
    Write-Host "  删除 $rel（$($files.Count) 个文件 / $mb MB）" -ForegroundColor DarkGray
    Remove-Item -Path $target -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $target) { Write-Warning "  未完全删除: $rel" } else { $freedTotal += $mb }
  }
  if ($freedTotal -gt 0) { Write-Host "  共释放 $freedTotal MB" -ForegroundColor DarkGray }
} else {
  Write-Host '[3/6] 跳过清理（未指定 -Cleanup）' -ForegroundColor DarkGray
}

# ------------------------------------------------------------ [4] 部署
if ($UseInstaller) {
  Write-Host '[4/6] 运行完整安装包（请在向导中点「下一步」直到完成）...' -ForegroundColor Cyan
  $setup = Get-ChildItem -Path (Join-Path $root 'runtime\desktop-updates') -Filter '*-setup.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $setup) { Write-Error 'runtime\desktop-updates 下没有找到安装包，请先 npm run package:tauri'; exit 1 }
  Write-Host "  $($setup.Name)（$([math]::Round($setup.Length / 1MB, 1)) MB）" -ForegroundColor DarkGray
  $setupProcess = if ($QuietInstall) {
    Start-Process -FilePath $setup.FullName -ArgumentList "/S /D=$installDir" -Wait -PassThru
  } else {
    Start-Process -FilePath $setup.FullName -Wait -PassThru
  }
  if ($setupProcess.ExitCode -ne 0) { throw "安装程序未成功结束，退出码 $($setupProcess.ExitCode)" }
  Write-Host '  安装程序已退出' -ForegroundColor DarkGray
} else {
  # 复制顺序很重要（2026-08-15 回归）：data 必须早于 dist。
  # 客户端用 ?v=DATA_VERSION 请求 /data/*.json；若新 dist（新版本号）对着旧 data 提供过一次，
  # WebView2 会把旧 body 以 immutable 一年缓存写进新 URL，之后再也不刷新。
  # data-first 保证版本号永远指向匹配的内容。
  #
  # 聚合产物自 2026-08-28 起不入库（源 = data/scenes/ 与 data/popular/ 分片），
  # 且安装目录不含 scripts/（无法自愈），所以拷贝前必须先把产物构建新鲜。
  Write-Host '[4/6] 刷新数据产物 + 增量复制 ...' -ForegroundColor Cyan
  node (Join-Path $root 'scripts\maintenance\build-scenes.js')
  if ($LASTEXITCODE -ne 0) { throw 'build-scenes failed - aborting deploy' }
  node (Join-Path $root 'scripts\maintenance\build-popular.js')
  if ($LASTEXITCODE -ne 0) { throw 'build-popular failed - aborting deploy' }
  node (Join-Path $root 'scripts\maintenance\build-blueprints.js')
  if ($LASTEXITCODE -ne 0) { throw 'build-blueprints failed - aborting deploy' }

  $map = @(
    @{ src = 'data';         dst = 'data' },
    @{ src = 'dist';         dst = 'dist' },
    @{ src = 'assets';       dst = 'assets' },
    @{ src = 'routes';       dst = 'routes' },
    @{ src = 'server';       dst = 'server' },
    @{ src = 'docs';         dst = 'docs' },
    @{ src = 'services';     dst = 'services' },
    # scripts/lib 是 server/config.js、tunnel.js 与 routes/maintenance.js 的运行时依赖
    # （runtime-paths / scene-store），安装目录没有 scripts/，必须随增量同步。
    @{ src = 'scripts/lib';  dst = 'scripts/lib' }
  )
  foreach ($item in $map) {
    $src = Join-Path $root $item.src
    $dst = Join-Path $gatewayDir $item.dst
    if (Test-Path $src) {
      New-Item -ItemType Directory -Force -Path $dst | Out-Null
      if ($item.src -eq 'assets') {
        Get-ChildItem -LiteralPath $src | Where-Object { $_.Name -notin @('live2d-candidates', 'character-references') } |
          ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $dst -Recurse -Force }
      } else {
        Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force
      }
      Write-Host "  copied $($item.src) -> gateway/$($item.dst)" -ForegroundColor DarkGray
    }
  }
  $serverJsSrc = Join-Path $root 'server.js'
  if (Test-Path $serverJsSrc) {
    Copy-Item -Path $serverJsSrc -Destination (Join-Path $gatewayDir 'server.js') -Force
    Write-Host '  copied server.js -> gateway/server.js' -ForegroundColor DarkGray
  }

  # Copy-Item 是合并，dist/_app 下的哈希产物会无限堆积（2026-08-16 实测 21 个陈旧
  # CompanionView chunk）。内容哈希同名即同内容，故只删真正失效的 chunk。
  # 仍停留在旧 index.html 的标签页重装前可能 404 某个懒加载 chunk——本地应用可接受。
  $newApp = Join-Path $root 'dist\_app'
  $dstApp = Join-Path $gatewayDir 'dist\_app'
  if ((Test-Path $newApp) -and (Test-Path $dstApp)) {
    $keep = @(Get-ChildItem -File $newApp | ForEach-Object { $_.Name })
    $stale = @(Get-ChildItem -File $dstApp | Where-Object { $keep -notcontains $_.Name })
    if ($stale.Count -gt 0) {
      $stale | ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
      Write-Host "  pruned $($stale.Count) stale hashed asset(s) from dist/_app" -ForegroundColor DarkGray
    }
  }

  # 应用内自动更新（tauri-plugin-updater）：把发布产物同步到安装版伺服目录
  # gateway/runtime/desktop-updates（server.js 的 /desktop-updates 静态伺服点，
  # 安装版 ROOT_DIR = gateway 目录）。latest.json 版本 > 当前安装版本时客户端
  # 启动即弹「一键升级」；只同步最新安装包 + 签名 + 清单，跳过 .prev 旧包防膨胀。
  $updatesSrc = Join-Path $root 'runtime\desktop-updates'
  $updatesDst = Join-Path $gatewayDir 'runtime\desktop-updates'
  if (Test-Path (Join-Path $updatesSrc 'latest.json')) {
    New-Item -ItemType Directory -Force -Path $updatesDst | Out-Null
    $latestExe = Get-ChildItem -Path $updatesSrc -Filter '*-setup.exe' -File |
      Where-Object { $_.Name -notlike '*.prev-*' } |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latestExe) {
      Copy-Item -Path $latestExe.FullName -Destination (Join-Path $updatesDst $latestExe.Name) -Force
      $sigFile = "$($latestExe.FullName).sig"
      if (Test-Path $sigFile) {
        Copy-Item -Path $sigFile -Destination (Join-Path $updatesDst "$($latestExe.Name).sig") -Force
      }
    }
    Copy-Item -Path (Join-Path $updatesSrc 'latest.json') -Destination (Join-Path $updatesDst 'latest.json') -Force
    # 清理安装版旧版本安装包（只留最新一个 + 对应签名），防 Program Files 持续膨胀
    # （2026-08-31：1.5.0/1.5.1/1.5.2 三套包曾堆到 900MB+）。
    if ($latestExe) {
      $stalePkgs = Get-ChildItem -Path $updatesDst -Filter '*-setup.exe' -File |
        Where-Object { $_.Name -ne $latestExe.Name }
      foreach ($stale in $stalePkgs) {
        Remove-Item $stale.FullName -Force -ErrorAction SilentlyContinue
        $staleSig = "$($stale.FullName).sig"
        if (Test-Path $staleSig) { Remove-Item $staleSig -Force -ErrorAction SilentlyContinue }
      }
      if ($stalePkgs.Count -gt 0) {
        Write-Host "  pruned $($stalePkgs.Count) old setup package(s) from gateway/runtime/desktop-updates" -ForegroundColor DarkGray
      }
    }
    Write-Host '  synced desktop-updates -> gateway/runtime/desktop-updates' -ForegroundColor DarkGray
  }
}

if ($SyncLocalModels) {
  $modelSource = Join-Path $root 'runtime\live2d-imports'
  $modelTarget = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'com.aics.studio\gateway\live2d-imports'
  node (Join-Path $root 'scripts\maintenance\sync-local-live2d.js') --source $modelSource --target $modelTarget --apply
  if ($LASTEXITCODE -ne 0) { throw '本机 Live2D 同步核验失败' }
}

# ------------------------------------------- [5] 清 WebView2 缓存 + 验证依赖
Write-Host '[5/6] 清理 WebView2 缓存 ...' -ForegroundColor Cyan
# 纵深防御：即便顺序正确，之前坏窗口里以 immutable 缓存的条目也会一直遮蔽新数据。
# 这些缓存纯性能用途，不含用户数据（IndexedDB / Local Storage 不受影响）。
$webviewBase = Join-Path $env:LOCALAPPDATA 'com.aics.studio\EBWebView\Default'
foreach ($cacheDir in @('Cache', 'Code Cache', 'GPUCache')) {
  $target = Join-Path $webviewBase $cacheDir
  if (Test-Path $target) {
    Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  cleared WebView2 $cacheDir" -ForegroundColor DarkGray
  }
}

# 真实反推依赖必须能 require，而不是只看目录在不在——缺了它引擎会静默降级为启发式兜底
Write-Host '[5/6] 验证真实反推依赖 ...' -ForegroundColor Cyan
if (Test-Path (Join-Path $gatewayDir 'node_modules\onnxruntime-node')) {
  Push-Location $gatewayDir
  node -e "require('onnxruntime-node'); require('sharp'); console.log('  NATIVE_OK：真实反推（WD14）可用')"
  $nativeOk = $LASTEXITCODE
  Pop-Location
  if ($nativeOk -ne 0) { Write-Warning '  原生模块加载失败，真实反推不可用' }
} else {
  Write-Warning '  node_modules\onnxruntime-node 缺失 —— 真实反推将降级为启发式兜底'
}

# ------------------------------------------------------------ [6] 启动
if (-not $NoRestart) {
  Write-Host '[6/6] 启动桌面端 ...' -ForegroundColor Cyan
  # 经 explorer 中转，让子进程脱离管理员令牌（UIPI 下拖放文件才正常）
  Start-Process explorer.exe -ArgumentList "`"$installDir\ai-cg-studio-desktop.exe`""
} else {
  Write-Host '[6/6] 已按 -NoRestart 跳过启动' -ForegroundColor DarkGray
}

$after = [math]::Round((Get-ChildItem -Path $installDir -Recurse -File -ErrorAction SilentlyContinue |
  Measure-Object -Property Length -Sum).Sum / 1MB, 1)
Write-Host "完成。安装目录当前 $after MB" -ForegroundColor Green
Stop-Transcript | Out-Null

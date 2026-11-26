# 部署参数、用户目录、工具更新与辅助操作。
# 由 deploy-desktop-quick.ps1 在入口作用域内加载。

function Write-DeploymentLog([string]$Message) {
  try { Add-Content -LiteralPath $deploymentLogPath -Value $Message -Encoding UTF8 } catch { }
}
function Fail-DesktopDeployment([string]$Message, [int]$ExitCode = 1, [string[]]$Hints = @(), [switch]$AlreadyLogged) {
  if (-not $AlreadyLogged) { Write-DeploymentLog "[desktop:failed] $Message" }
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
function Resolve-DesktopProfileDirectory([string]$Path, [string]$Name) {
  if ($Path -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)' -or $Path -match '["\x00-\x1f]') {
    throw "无法确认发起部署的用户目录：$Name"
  }
  $full = [IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\','/'))
  if ($full -match '^[A-Za-z]:$') { throw "$Name 不能是驱动器根目录。" }
  return $full
}

if ($DeferRestart -and (-not $OriginalAppData -or -not $OriginalLocalAppData)) {
  throw '提权过程未携带发起部署的 APPDATA 和 LOCALAPPDATA。请重新运行 deploy-desktop.bat。'
}
$profileAppData = Resolve-DesktopProfileDirectory $(if ($OriginalAppData) { $OriginalAppData } else { $env:APPDATA }) 'APPDATA'
$profileLocalAppData = Resolve-DesktopProfileDirectory $(if ($OriginalLocalAppData) { $OriginalLocalAppData } else { $env:LOCALAPPDATA }) 'LOCALAPPDATA'
$profileDesktop = if ($OriginalDesktop) { Resolve-DesktopProfileDirectory $OriginalDesktop 'Desktop' }
  elseif (-not $DeferRestart -and ($desktop = [Environment]::GetFolderPath('Desktop'))) { Resolve-DesktopProfileDirectory $desktop 'Desktop' }
$profilePrograms = if ($OriginalPrograms) { Resolve-DesktopProfileDirectory $OriginalPrograms 'Programs' }
  elseif (-not $DeferRestart -and ($programs = [Environment]::GetFolderPath('Programs'))) { Resolve-DesktopProfileDirectory $programs 'Programs' }

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
$configRoot = Join-Path $profileAppData 'com.aics.studio'
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
function Remove-DesktopReferenceCopy([string]$Id) {
  if ($Id -cnotmatch '^[a-f0-9]{32}$') { throw '无效的参考素材临时目录编号。' }
  $copy = Resolve-DesktopChildPath -Root $root -Relative "runtime\desktop-reference-sync\$Id"
  if (-not (Test-Path -LiteralPath $copy -PathType Container)) { return }
  $contents = @(Get-ChildItem -LiteralPath $copy -Force)
  if ($contents.Count -eq 0) { [IO.Directory]::Delete($copy, $false); return }
  if ($contents.Count -ne 1 -or $contents[0].Name -cne 'references' -or -not $contents[0].PSIsContainer) { return }
  $shards = Resolve-DesktopChildPath -Root $copy -Relative 'references'
  $files = @(Get-ChildItem -LiteralPath $shards -Force)
  if ($files | Where-Object { $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      $_.LinkType -or $_.Name -cnotmatch '^[a-z0-9][a-z0-9_]*\.json$' }) { return }
  foreach ($file in $files) { [IO.File]::Delete((Resolve-DesktopChildPath -Root $shards -Relative $file.Name)) }
  [IO.Directory]::Delete($shards, $false)
  [IO.Directory]::Delete($copy, $false)
}

function Remove-StaleDeploymentCopies {
  $references = Resolve-DesktopChildPath -Root $root -Relative 'runtime\desktop-reference-sync'
  if (Test-Path -LiteralPath $references -PathType Container) {
    $cutoff = [DateTime]::UtcNow.AddDays(-1)
    foreach ($candidate in @(Get-ChildItem -LiteralPath $references -Directory -Force | Where-Object {
      $_.Name -cmatch '^[a-f0-9]{32}$' -and $_.LastWriteTimeUtc -lt $cutoff -and
        -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)
    })) {
      Remove-DesktopReferenceCopy $candidate.Name
    }
  }
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
  $desktop = $profileDesktop
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
  if ($hosts.Count -gt 1 -or ($hosts.Count -eq 0 -and $allProcesses.Count -gt 0)) {
    Write-Host "[desktop:auto] 检测到异常或重复桌面端实例（PID $($allProcesses.Id -join ', ')），正在自动清理 ..." -ForegroundColor Yellow
    Stop-DesktopForDeployment -InstallDir $installDir -ConfigRoot $configRoot
    $allProcesses = @()
    $hosts = @()
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

function Test-DirectDeploymentCurrent($Plan) {
  return $Plan.mode -eq 'current' -and
    (Test-Path -LiteralPath (Join-Path $installDir '.huiyu-installed-resources.json') -PathType Leaf) -and
    -not ($SyncLocalModels -or $AdoptProjectCatalog -or $referenceIdList.Count)
}


function Find-StaleDeploymentScript {
  # A successful compile can preserve the output timestamp when emitted bytes
  # match (for example after a comment change). Its receipt certifies that case.
  $receipt = Join-Path $root '.cache\typescript-build\node.json'
  if (-not (Test-Path -LiteralPath $receipt -PathType Leaf)) { return $receipt }
  $builtAt = (Get-Item -LiteralPath $receipt).LastWriteTimeUtc
  foreach ($file in @('tsconfig.node.json', 'package-lock.json', 'scripts\build-node.mts')) {
    if ((Get-Item -LiteralPath (Join-Path $root $file)).LastWriteTimeUtc -gt $builtAt) { return $file }
  }
  $sourceDir = Join-Path $root 'scripts'
  $sources = Get-ChildItem -LiteralPath $sourceDir -File -Recurse | Where-Object { $_.Extension -in @('.ts','.mts') }
  foreach ($source in $sources) {
    $relative = $source.FullName.Substring($sourceDir.Length + 1)
    if ($relative -match '^(?:archive|maintenance\\ui-shots)\\|\.d\.ts$') { continue }
    $ext = if ($source.Extension -eq '.mts') { '.mjs' } else { '.js' }
    $output = [IO.Path]::ChangeExtension($source.FullName, $ext)
    if (-not (Test-Path -LiteralPath $output -PathType Leaf)) { return $relative }
    if ($source.LastWriteTimeUtc -gt $builtAt -and
        $source.LastWriteTimeUtc -gt (Get-Item -LiteralPath $output).LastWriteTimeUtc) { return $relative }
  }
}

function Update-DesktopDeploymentScripts {
  # The parent has already validated the scripts before selecting a plan.
  if ($DeferRestart) { return }
  $stale = Find-StaleDeploymentScript
  if (-not $stale) { return }
  Write-Host "  · 更新部署辅助脚本（$stale） ..." -ForegroundColor DarkGray
  Push-Location $root
  try { Invoke-DesktopNpm -Arguments @('run','build:runtime') -PrettyConsole:$true }
  finally { Pop-Location }
}

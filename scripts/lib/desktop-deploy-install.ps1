# 在部署锁保护下写入、校验安装并同步用户数据。
# 由 deploy-desktop-quick.ps1 在入口作用域内加载。

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
    if (Test-DirectDeploymentCurrent $plan) {
      Write-Host '  ✓ 构建完成后与已安装文件完全一致，无需写入。' -ForegroundColor Green
      try { $null = Complete-CurrentDeployment; $moduleExitCode = 0; return } finally { Remove-DirectDeploymentPlan }
    }
  }
} elseif ($buildUpgrade) {
  Write-Host '[1/6] 准备本机快速构建与轻量升级包 ...' -ForegroundColor Cyan
  $candidate = $null
  if (-not $SkipBuild -and -not $ForceBuild -and -not $DeploymentPlanApplied) {
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
  if (-not $installMutexHeld) {
    $installBusy = $true
    if ($DeferRestart) { Write-Host 'DESKTOP_DEPLOY_BUSY: 该安装目录已有直写部署。' -ForegroundColor Yellow }
    else { Write-DesktopSummary -Kind 'busy' -Title '该安装目录已有直写部署' -Details @('请等待上一个部署窗口完成后再重试。') }
    $moduleExitCode = 73
    return
  }
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
    foreach ($directory in @([Environment]::GetFolderPath('CommonDesktopDirectory'),$profileDesktop,[Environment]::GetFolderPath('CommonPrograms'),$profilePrograms)) {
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
  $modelTarget = Join-Path $configRoot 'gateway\live2d-imports'
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
    $referenceCopyId = [Guid]::NewGuid().ToString('N')
    try {
      $referenceSource = Resolve-DesktopChildPath -Root $root -Relative "runtime\desktop-reference-sync\$referenceCopyId"
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
    } finally {
      try { Remove-DesktopReferenceCopy $referenceCopyId }
      catch { Write-Host "[desktop:cleanup] 清理参考素材临时副本失败：$($_.Exception.Message)" -ForegroundColor Yellow }
    }
    Write-DesktopDuration '个人参考分片同步'
  }
}
Write-Host '[5/6] 安装完整性校验通过（宿主、Rust 网关与原生库哈希一致）' -ForegroundColor DarkGray
if ($StartupRepair) {
  $webviewBase = Join-Path $profileLocalAppData 'com.aics.studio\EBWebView\Default'
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

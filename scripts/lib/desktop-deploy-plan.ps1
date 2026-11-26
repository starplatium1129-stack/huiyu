# 检测安装与构建状态，在提权前确定并绑定部署载荷。
# 由 deploy-desktop-quick.ps1 在入口作用域内加载。

Update-DesktopDeploymentScripts
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
      if (Test-DirectDeploymentCurrent $plan) {
        Write-DesktopDecision -Mode '已是最新（免提权、免构建）' -Reason "已安装的全部 $($plan.files) 项文件与当前源码和构建完全一致"
        try { $null = Complete-CurrentDeployment; $moduleExitCode = 0; return } finally { Remove-DirectDeploymentPlan; Publish-DeploymentLog }
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
        Write-Host '  · 检测到桌面端正在运行，构建完成进入写入阶段时将自动关闭。' -ForegroundColor DarkGray
      }
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
      if (Test-DirectDeploymentCurrent $plan) {
        Write-Host '  ✓ 构建完成后与已安装文件完全一致，无需提权写入。' -ForegroundColor Green
        try { $null = Complete-CurrentDeployment; $moduleExitCode = 0; return } finally { Remove-DirectDeploymentPlan; Publish-DeploymentLog }
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
          try { $null = Complete-CurrentDeployment; $moduleExitCode = 0; return } finally { Publish-DeploymentLog }
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

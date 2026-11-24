# Dot-sourced by the desktop deployment entry; $root belongs to that entry.
$script:DesktopStageNames = @{
  'data preparation' = '准备数据与配置'
  'source identity' = '计算源码指纹'
  'Rust runtime (desktop-local)' = '编译 Rust 网关（快速档）'
  'Rust runtime (release)' = '编译 Rust 网关（发行档）'
  'web build and precompression' = '构建前端与预压缩'
  'desktop UI' = '构建桌面端界面'
  'resource cleanup tool' = '准备资源清理工具'
  'installer assets' = '准备安装器素材'
  'resource staging' = '暂存静态资源'
  'remote scene recipes' = '准备远程场景配方'
  'frontend artifact identity' = '校验前端产物指纹'
  'Tauri native build and bundle' = '编译桌面宿主程序'
  'build binding' = '生成构建绑定回执'
  'cached frontend verification' = '校验前端复用缓存'
  'data precompression' = '刷新数据预压缩'
  'upgrade source verification' = '核对升级包构建来源'
  'upgrade retained file selection' = '筛选可复用已安装文件'
  'installed upgrade prerequisites' = '预检目标目录升级条件'
  'local upgrade NSIS bundle' = '封装本机增量升级包'
  'upgrade NSIS compression' = '压缩升级安装包'
  'upgrade payload binding' = '绑定升级包校验清单'
}

function Format-DesktopStageName {
  param([string]$Name)
  $trimmed = $Name.Trim()
  if ($script:DesktopStageNames.ContainsKey($trimmed)) { return $script:DesktopStageNames[$trimmed] }
  return $trimmed
}

function Write-DesktopRule {
  param([ConsoleColor]$Color = 'DarkGray')
  Write-Host '------------------------------------------------------------' -ForegroundColor $Color
}

function Write-DesktopBanner {
  param(
    [string]$Version,
    [string]$GitInfo,
    [string]$BranchWarning,
    [string]$InstallDir,
    [string]$InstallState,
    [string]$RunningState
  )
  Write-Host ''
  Write-Host '============================================================' -ForegroundColor Cyan
  Write-Host '  绘遇 HUIYU · 桌面端自动部署' -ForegroundColor Cyan
  Write-Host '============================================================' -ForegroundColor Cyan
  $versionLine = if ($GitInfo) { "v$Version  ($GitInfo)" } else { "v$Version" }
  Write-Host '  · 工作区版本  ' -NoNewline -ForegroundColor DarkGray; Write-Host $versionLine -ForegroundColor White
  if ($BranchWarning) {
    Write-Host '  ! 分支提醒    ' -NoNewline -ForegroundColor Yellow; Write-Host $BranchWarning -ForegroundColor Yellow
  }
  Write-Host '  · 安装目录    ' -NoNewline -ForegroundColor DarkGray; Write-Host $InstallDir -ForegroundColor White
  Write-Host '  · 当前状态    ' -NoNewline -ForegroundColor DarkGray; Write-Host "$InstallState  |  $RunningState" -ForegroundColor Gray
  Write-Host '  · 日志位置    ' -NoNewline -ForegroundColor DarkGray; Write-Host 'runtime\desktop-deploy-last.log / desktop-deploy-build.log' -ForegroundColor DarkGray
  Write-DesktopRule
}

function Write-DesktopDecision {
  param([string]$Mode, [string]$Reason)
  Write-Host '  ▸ 部署方案    ' -NoNewline -ForegroundColor Cyan; Write-Host $Mode -ForegroundColor White
  if ($Reason) {
    Write-Host '  · 判定依据    ' -NoNewline -ForegroundColor DarkGray; Write-Host $Reason -ForegroundColor Gray
  }
  Write-DesktopRule
}

function Write-DesktopRelayLine {
  param([string]$Line)
  if (-not $Line) { return }
  if ($Line -match '^\[([1-6]/6)\]\s*(.+)$') {
    Write-Host "[$($Matches[1])] $($Matches[2])" -ForegroundColor Cyan
    return
  }
  if ($Line -match '^\[desktop:stage\]\s*(.+?)\s*(?:\.\.\.)?$') {
    $label = Format-DesktopStageName $Matches[1]
    Write-Host "    ▸ $label ..." -ForegroundColor DarkCyan
    return
  }
  if ($Line -match '^\[desktop:timing\]\s*(.+?):\s*([0-9.]+s)$') {
    $label = Format-DesktopStageName $Matches[1]
    $color = if ($label -eq '部署总耗时') { 'Green' } else { 'DarkGray' }
    Write-Host "    ✓ $label（$($Matches[2])）" -ForegroundColor $color
    return
  }
  if ($Line -match '^\[desktop:(direct|catalog|ok)\]\s*(.+)$') {
    Write-Host "  ✓ $($Matches[2])" -ForegroundColor Green
    return
  }
  if ($Line -match '^\[desktop:(auto|detect)\]\s*(.+)$') {
    Write-Host "  ▸ $($Matches[2])" -ForegroundColor Cyan
    return
  }
  if ($Line -match '^\[desktop:(cleanup|cache)\]\s*(.+)$') {
    Write-Host "    · $($Matches[2])" -ForegroundColor DarkGray
    return
  }
  if ($Line -match '^\[desktop:(recovery|warn)\]\s*(.+)$') {
    Write-Host "  ! $($Matches[2])" -ForegroundColor Yellow
    return
  }
  if ($Line -match '^\[desktop:detail\]\s*(.*)$') {
    Write-Host "    | $($Matches[1])" -ForegroundColor DarkRed
    return
  }
  if ($Line -match '^\[desktop:failed\]\s*(.+)$') {
    Write-Host "  ✗ $($Matches[1])" -ForegroundColor Red
    return
  }
  if ($Line -match '^DESKTOP_') {
    Write-Host "  ✗ $Line" -ForegroundColor Red
    return
  }
}

function Write-DesktopSummary {
  param(
    [ValidateSet('success', 'cancelled', 'busy', 'error')][string]$Kind,
    [string]$Title,
    [string[]]$Details = @()
  )
  $color = switch ($Kind) {
    'success' { 'Green' }
    'cancelled' { 'Yellow' }
    'busy' { 'Yellow' }
    default { 'Red' }
  }
  $icon = switch ($Kind) {
    'success' { '✓' }
    'cancelled' { '!' }
    'busy' { '!' }
    default { '✗' }
  }
  Write-Host ''
  Write-DesktopRule -Color $color
  Write-Host "  $icon $Title" -ForegroundColor $color
  foreach ($item in $Details) {
    if ($item) { Write-Host "    $item" -ForegroundColor Gray }
  }
  Write-DesktopRule -Color $color
}

function Invoke-DesktopNpm {
  param(
    [string[]]$Arguments,
    [switch]$PrettyConsole
  )
  # Windows PowerShell turns native stderr into ErrorRecord objects. Stream it
  # as progress text and judge success only by the native process exit code.
  $previousPreference = $ErrorActionPreference
  $npmCommand = Get-Command npm.cmd -CommandType Application -ErrorAction Stop
  $detailPath = Join-Path $root 'runtime\desktop-deploy-build.log'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $detailPath) | Out-Null
  $detailStream = [IO.File]::Open($detailPath, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
  $detailWriter = New-Object IO.StreamWriter($detailStream, (New-Object Text.UTF8Encoding($false)))
  try {
    $detailWriter.WriteLine(("`n[{0:yyyy-MM-dd HH:mm:ss}] npm {1}" -f (Get-Date), ($Arguments -join ' ')))
    $ErrorActionPreference = 'Continue'
    & $npmCommand.Source @Arguments 2>&1 | ForEach-Object {
      $line = $_.ToString()
      $detailWriter.WriteLine($line)
      if ($line -match '^\[desktop:(stage|timing)\]') {
        if ($PrettyConsole) {
          Write-DesktopRelayLine $line
          if (Get-Command Write-DeploymentLog -ErrorAction SilentlyContinue) { Write-DeploymentLog $line }
        } else {
          Write-Host $line
        }
      } elseif ($line -match '^error(?:\[|:|\s)|^npm (?:ERR!|error)') {
        if ($PrettyConsole) {
          Write-Host "    | $line" -ForegroundColor DarkRed
          if (Get-Command Write-DeploymentLog -ErrorAction SilentlyContinue) { Write-DeploymentLog "[desktop:detail] $line" }
        } else {
          Write-Host $line
        }
      }
    }
    $buildExitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousPreference; $detailWriter.Dispose() }
  if ($buildExitCode -ne 0) {
    if ($PrettyConsole) {
      Write-Host '  ✗ 构建输出末尾（最近 20 行）：' -ForegroundColor Red
      Get-Content -LiteralPath $detailPath -Tail 20 -Encoding UTF8 | ForEach-Object {
        Write-Host "    | $_" -ForegroundColor DarkRed
        if (Get-Command Write-DeploymentLog -ErrorAction SilentlyContinue) { Write-DeploymentLog "[desktop:detail] $_" }
      }
    } else {
      Write-Host '[desktop:failed] 构建输出末尾：' -ForegroundColor Red
      Get-Content -LiteralPath $detailPath -Tail 20 -Encoding UTF8 | ForEach-Object { Write-Host "[desktop:detail] $_" }
    }
    throw "桌面构建/封装失败（退出码 $buildExitCode）；未关闭应用。完整输出：$detailPath"
  }
}

# Dot-sourced by the desktop deployment entry; $root belongs to that entry.
function Invoke-DesktopNpm {
  param([string[]]$Arguments)
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
      if ($line -match '^\[desktop:(stage|timing)\]|^error(?:\[|:|\s)|^npm (?:ERR!|error)') { Write-Host $line }
    }
    $buildExitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousPreference; $detailWriter.Dispose() }
  if ($buildExitCode -ne 0) {
    Write-Host '[desktop:failed] 构建输出末尾：' -ForegroundColor Red
    Get-Content -LiteralPath $detailPath -Tail 20 | ForEach-Object { Write-Host "[desktop:detail] $_" }
    throw "桌面构建/封装失败（退出码 $buildExitCode）；未关闭应用。完整输出：$detailPath"
  }
}

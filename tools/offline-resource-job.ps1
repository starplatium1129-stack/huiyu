param(
  [Parameter(Mandatory=$true)][string]$Archive,
  [Parameter(Mandatory=$true)][string]$GatewayRoot,
  [Parameter(Mandatory=$true)][string]$NativeExecutable,
  [Parameter(Mandatory=$true)][string]$RuntimeRoot,
  [switch]$Apply,
  [string]$ResumeStaging
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$state = [hashtable]::Synchronized(@{ Cancel=$false; Phase='inventory'; Done=0L; Total=0L; Staging=$null; CanResume=$false; Result=$null; Error=$null })
$options = @{ Archive=$Archive; GatewayRoot=$GatewayRoot; NativeExecutable=$NativeExecutable;
  InstallDir=(Split-Path $GatewayRoot -Parent); RuntimeRoot=$RuntimeRoot; TrustedRelease=$true; DirectMount=$true; ProgressState=$state; Apply=[bool]$Apply }
if ($Apply -and $ResumeStaging) { $options.ResumeStaging = $ResumeStaging }
$worker = Join-Path $PSScriptRoot 'install-offline-resources.ps1'
$shell = [PowerShell]::Create()
$shell.AddScript({ param($worker, $options, $state)
  try { $state.Result = (& $worker @options) | ConvertFrom-Json }
  catch { $state.Error = $_.Exception.Message }
}).AddArgument($worker).AddArgument($options).AddArgument($state) | Out-Null
function Send-Record($value) { [Console]::WriteLine(($value | ConvertTo-Json -Depth 12 -Compress)) }
try {
  $handle = $shell.BeginInvoke()
  $inputStream = [Console]::OpenStandardInput()
  $cancelRead = $inputStream.ReadAsync((New-Object byte[] 1), 0, 1)
  while (-not $handle.IsCompleted) {
    if ($cancelRead.IsCompleted) { $state.Cancel = $true }
    Send-Record @{ type='progress'; phase=$state.Phase; done=$state.Done; total=$state.Total }
    [Threading.Thread]::Sleep(150)
  }
  $shell.EndInvoke($handle) | Out-Null
  if (-not $Apply -and $state.Result.ok -and -not $state.Error -and $state.Result.sourceType -ne 'directory') {
    $tempRoot = Join-Path (Split-Path $RuntimeRoot -Parent) 'resource-packages'
    if ($state.Result.packageMode -eq 'delta') { $tempRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Temp' }
    $retained = if (Test-Path -LiteralPath $tempRoot -PathType Container) { Get-ChildItem -LiteralPath $tempRoot -Filter 'huiyu-offline-import-*.resume.json' -File | Sort-Object LastWriteTimeUtc -Descending } else { @() }
    foreach ($file in $retained) {
      try {
        if ($file.Name -notmatch '^huiyu-offline-import-[a-f0-9-]{36}\.resume\.json$' -or $file.Length -gt 8192 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
        $record = [IO.File]::ReadAllText($file.FullName) | ConvertFrom-Json
        $staging = $file.FullName -replace '\.resume\.json$', ''
        if ($record.schemaVersion -eq 1 -and $record.kind -eq 'huiyu-offline-staging' -and
            $record.releaseSha256 -ceq $state.Result.releaseSha256 -and $record.releaseId -ceq $state.Result.releaseId -and
            $record.installDir.TrimEnd('\') -ieq $state.Result.installDir.TrimEnd('\') -and
            $record.runtimeRoot.TrimEnd('\') -ieq $state.Result.runtimeRoot.TrimEnd('\') -and
            (Test-Path -LiteralPath $staging -PathType Container)) {
          # This is only a candidate. The installer validates the record, paths
          # and every retained file again before it can write resource pointers.
          $state.Staging = $staging; $state.CanResume = $true; break
        }
      } catch { continue }
    }
  }
  # Full packages stay in their extracted directory; assets are read on demand.
  # Incremental packages retain the existing transactional import path.
  Send-Record @{ type='result'; result=$state.Result; error=$state.Error;
    staging=$state.Staging; canResume=$state.CanResume; cancelled=[bool]$state.Cancel }
} catch {
  Send-Record @{ type='result'; error=$_.Exception.Message; staging=$state.Staging; canResume=$state.CanResume; cancelled=[bool]$state.Cancel }
} finally { $shell.Dispose() }

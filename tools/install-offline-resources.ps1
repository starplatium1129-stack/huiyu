param(
  [Parameter(Mandatory=$true)][string]$Archive,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedReleaseSha256,
  [string]$InstallDir,
  [string]$RuntimeRoot,
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

function Get-BytesHash([byte[]]$Bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
function Assert-OrdinaryPath([string]$Value, [switch]$AllowMissing) {
  $absolute = [IO.Path]::GetFullPath($Value)
  if ($absolute.StartsWith('\\')) { throw 'Network paths are not supported.' }
  $current = $absolute
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked paths are not supported.' }
    } elseif (-not $AllowMissing -and $current -eq $absolute) { throw "Missing path: $absolute" }
    $current = [IO.Path]::GetDirectoryName($current)
  }
  return $absolute
}
function Assert-EntryPath([string]$Name) {
  if (-not $Name -or $Name -match '[\\:%\x00-\x1f\x7f<>"|?*]' -or $Name.StartsWith('/')) { throw 'Unsafe ZIP path.' }
  foreach ($part in $Name.Split('/')) {
    if (-not $part -or $part -eq '.' -or $part -eq '..' -or $part -match '[. ]$' -or $part -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') { throw 'Unsafe ZIP path segment.' }
  }
}
function Read-EntryBytes($Entry, [long]$Limit) {
  if ($Entry.Length -gt $Limit) { throw 'Metadata exceeds its size limit.' }
  $inputStream = $Entry.Open()
  $outputStream = New-Object IO.MemoryStream
  try {
    $buffer = New-Object byte[] 65536
    while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      if ($outputStream.Length + $count -gt $Limit) { throw 'Decompressed metadata exceeds its size limit.' }
      $outputStream.Write($buffer, 0, $count)
    }
    return ,$outputStream.ToArray()
  } finally { $inputStream.Dispose(); $outputStream.Dispose() }
}
if (-not $InstallDir) {
  $locations = @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AI-CG-Studio',
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AI-CG-Studio',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\AI-CG-Studio') |
    ForEach-Object { (Get-ItemProperty -LiteralPath $_ -ErrorAction SilentlyContinue).InstallLocation } |
    Where-Object { $_ } | ForEach-Object { $_.Trim('"') } | Select-Object -Unique
  if (@($locations).Count -gt 1) { throw 'Multiple installations found; specify -InstallDir.' }
  $InstallDir = if ($locations) { @($locations)[0] } else { 'C:\Program Files\AI-CG-Studio' }
}
$installPath = Assert-OrdinaryPath $InstallDir
$gateway = Join-Path $installPath 'gateway'
$runtimeExe = Assert-OrdinaryPath (Join-Path $gateway 'huiyu-runtime.exe')
if (-not $RuntimeRoot) { $RuntimeRoot = Join-Path $env:APPDATA 'com.aics.studio\gateway' }
$runtimePath = Assert-OrdinaryPath $RuntimeRoot -AllowMissing
$archivePath = Assert-OrdinaryPath $Archive
$zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
$staging = $null
$complete = $false
try {
  $releaseEntry = $zip.GetEntry('release.json')
  if (-not $releaseEntry) { throw 'release.json is missing.' }
  $releaseBytes = Read-EntryBytes $releaseEntry 16777216
  if ((Get-BytesHash $releaseBytes) -ne $ExpectedReleaseSha256.ToLowerInvariant()) { throw 'Release approval hash mismatch. Obtain the hash from a trusted publication page.' }
  $release = [Text.Encoding]::UTF8.GetString($releaseBytes) | ConvertFrom-Json
  if ($release.schemaVersion -ne 1 -or $release.kind -ne 'huiyu-offline-release' -or -not $release.files) { throw 'Unsupported offline release.' }
  $expected = @{}
  $expected['release.json'] = @{ bytes = $releaseBytes.Length; sha256 = $ExpectedReleaseSha256 }
  foreach ($file in $release.files) {
    Assert-EntryPath $file.path
    if ($file.path -notmatch '^(pack|showcase)/' -or $expected.ContainsKey($file.path) -or $file.sha256 -notmatch '^[a-f0-9]{64}$' -or $file.bytes -lt 0 -or [Math]::Floor($file.bytes) -ne $file.bytes) { throw 'Invalid release file inventory.' }
    $expected[$file.path] = $file
  }
  $seen = @{}
  [long]$totalBytes = 0
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName
    Assert-EntryPath $name
    # Reject symlinks and any non-regular Unix file types; Windows archives use type 0.
    $unixType = ($entry.ExternalAttributes -shr 16) -band 61440
    if (($unixType -ne 0 -and $unixType -ne 32768) -or ($entry.ExternalAttributes -band 1040)) { throw 'ZIP contains a link, directory or special file.' }
    if ($seen.ContainsKey($name) -or -not $expected.ContainsKey($name) -or $entry.Length -ne $expected[$name].bytes) { throw 'ZIP inventory differs from the approved release.' }
    $seen[$name] = $true
    $totalBytes += $entry.Length
  }
  if ($seen.Count -ne $expected.Count) { throw 'ZIP is incomplete.' }
  if (-not $Apply) {
    @{ ok=$true; mode='preview'; releaseId=$release.releaseId; files=$seen.Count; bytes=$totalBytes;
      runtimeRoot=$runtimePath; note='No files were written. Fully exit HUIYU, then repeat with -Apply.' } | ConvertTo-Json
    return
  }
  & $runtimeExe 'offline-import' '--help' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'This installation does not support offline import. Install the new HUIYU desktop release first.' }
  # Some Windows TEMP variables contain an 8.3 username alias. Use the physical
  # user profile path; native import deliberately rejects path aliases and links.
  $tempRoot = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Temp')) + '\'
  Assert-OrdinaryPath $tempRoot -AllowMissing | Out-Null
  $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($tempRoot))
  if ($drive.AvailableFreeSpace -lt $totalBytes + 65536) { throw 'Insufficient temporary disk space for the approved archive.' }
  $staging = Join-Path $tempRoot ('huiyu-offline-import-' + [Guid]::NewGuid().ToString())
  Assert-OrdinaryPath $staging -AllowMissing | Out-Null
  if (Test-Path -LiteralPath $staging) { throw 'Staging directory already exists.' }
  New-Item -ItemType Directory -Path $staging | Out-Null
  foreach ($entry in $zip.Entries) {
    $target = [IO.Path]::GetFullPath((Join-Path $staging $entry.FullName.Replace('/', '\')))
    if (-not $target.StartsWith($staging + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'ZIP target escaped staging.' }
    $parent = [IO.Path]::GetDirectoryName($target)
    Assert-OrdinaryPath $parent -AllowMissing | Out-Null
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $inputStream = $entry.Open()
    $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try {
      [long]$copied = 0
      $buffer = New-Object byte[] 65536
      while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $copied += $count
        if ($copied -gt $entry.Length) { throw 'ZIP data exceeds approved length.' }
        $outputStream.Write($buffer, 0, $count)
      }
      if ($copied -ne $entry.Length) { throw 'ZIP data is incomplete.' }
      $outputStream.Flush($true)
    } finally { $inputStream.Dispose(); $outputStream.Dispose() }
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $expected[$entry.FullName].sha256) { throw 'Extracted file hash mismatch.' }
  }
  & $runtimeExe 'offline-import' '--package-root' $staging '--expected-release-sha256' $ExpectedReleaseSha256 '--app-root' $gateway '--runtime-root' $runtimePath '--apply'
  if ($LASTEXITCODE -ne 0) { throw 'Native import failed. Keep the staging directory and inspect the diagnostic above.' }
  $complete = $true
  Write-Output 'Offline resources installed. Restart HUIYU to load the new library.'
} finally {
  $zip.Dispose()
  if ($staging) {
    if ($complete) {
      # Delete only the exact directory created above, inside the recorded TEMP root.
      $cleanup = Assert-OrdinaryPath $staging
      if (-not $cleanup.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($cleanup) -notmatch '^huiyu-offline-import-[a-f0-9-]{36}$') { throw 'Unsafe cleanup target.' }
      Remove-Item -LiteralPath $cleanup -Recurse -Force
    } else { Write-Warning "Incomplete import staging retained: $staging" }
  }
}

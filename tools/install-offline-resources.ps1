param(
  [Parameter(Mandatory=$true)][string]$Archive,
  [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedReleaseSha256,
  [string]$InstallDir,
  [string]$RuntimeRoot,
  [switch]$Apply,
  [switch]$Verify,
  [switch]$TrustedRelease,
  [hashtable]$ProgressState,
  [string]$ResumeStaging
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$watch = [Diagnostics.Stopwatch]::StartNew()
function Check-Cancel {
  if ($ProgressState -and $ProgressState.Cancel) { throw 'CANCELLED: Keep retained staging and retry.' }
  if ($watch.Elapsed.TotalHours -gt 1) { throw 'TIMEOUT: Verification/extraction timed out. Retry the same ZIP.' }
}
function Report-Progress([string]$Phase, [long]$Done, [long]$Total) {
  if ($ProgressState) { $ProgressState.Phase = $Phase; $ProgressState.Done = $Done; $ProgressState.Total = $Total }
}
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
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkType) { throw 'Linked paths are not supported.' }
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
      Check-Cancel
      if ($outputStream.Length + $count -gt $Limit) { throw 'Decompressed metadata exceeds its size limit.' }
      $outputStream.Write($buffer, 0, $count)
    }
    return ,$outputStream.ToArray()
  } finally { $inputStream.Dispose(); $outputStream.Dispose() }
}
function Invoke-NativeImport([string]$Package, [switch]$Probe) {
  $arguments = @('offline-import', '--package-root', $Package, '--expected-release-sha256', $ExpectedReleaseSha256,
    '--app-root', $gateway, '--runtime-root', $runtimePath, '--apply')
  if ($ProgressState) { $arguments += '--cancel-stdin' }
  if ($Probe) { $arguments = @('offline-import', '--help') }
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $runtimeExe
  # Quote Windows argv, including trailing backslashes; never compose a shell command.
  $start.Arguments = ($arguments | ForEach-Object { '"' + (($_ -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' }) -join ' '
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.StandardOutputEncoding = [Text.Encoding]::UTF8
  $start.StandardErrorEncoding = [Text.Encoding]::UTF8
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $start
  try {
    $process.Start() | Out-Null
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $cancelSent = $false
    $nativeWatch = [Diagnostics.Stopwatch]::StartNew()
    while (-not $process.WaitForExit(150)) {
      if ($Probe -and $nativeWatch.Elapsed.TotalSeconds -gt 15) {
        # This child only runs --help and cannot own an install transaction.
        $process.Kill(); $process.WaitForExit()
        throw 'TIMEOUT: Native capability check timed out.'
      }
      if ($ProgressState -and ($ProgressState.Cancel -or $watch.Elapsed.TotalHours -gt 1) -and -not $cancelSent) {
        # The native transaction owns rollback. Never kill it or release its lease.
        $process.StandardInput.Close()
        $cancelSent = $true
        Report-Progress 'cancelling' 0 0
      }
    }
    $output = $stdout.GetAwaiter().GetResult()
    $diagnostic = $stderr.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { throw "Native import failed ($($process.ExitCode)). $diagnostic $output" }
    $result = $output | ConvertFrom-Json
    if ($Probe) {
      if (-not $result.ok -or $result.usage -notmatch '--cancel-stdin') { throw 'USAGE: This runtime does not support --cancel-stdin. Install the matching new desktop build first.' }
      return
    }
    if (-not $result.ok -or $result.kind -ne 'huiyu-offline-import-result') { throw 'Native import did not confirm success.' }
    return $result
  } finally { $process.Dispose() }
}
if ($TrustedRelease -and $ExpectedReleaseSha256) { throw 'Choose catalog approval or an explicit independent approval, not both.' }
if (-not $TrustedRelease -and -not $ExpectedReleaseSha256) { throw 'Independent release approval is required.' }
if ($ResumeStaging -and -not $Apply) { throw 'Resume requires Apply.' }
if (-not $InstallDir) {
  # A bundled helper belongs to its own installation, even when another edition
  # has the uninstall registry entry. Standalone release attachments use discovery.
  $bundledRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
  if ((Split-Path $PSScriptRoot -Leaf) -eq 'tools' -and
      (Split-Path (Split-Path $PSScriptRoot -Parent) -Leaf) -eq 'gateway' -and
      (Test-Path -LiteralPath (Join-Path $bundledRoot 'gateway\huiyu-runtime.exe') -PathType Leaf)) {
    $InstallDir = $bundledRoot
  }
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
  Report-Progress 'inventory' 0 0
  if ($zip.Entries.Count -gt 50000) { throw 'Too many ZIP files.' }
  $releaseEntry = $zip.GetEntry('release.json')
  if (-not $releaseEntry) { throw 'release.json is missing.' }
  $releaseBytes = Read-EntryBytes $releaseEntry 16777216
  $releaseHash = Get-BytesHash $releaseBytes
  $trustedSource = $null
  if ($TrustedRelease) {
    # Independent publisher approval shipped with this helper, never loaded from
    # the selected ZIP, sibling checksums or a user setting. Checked 2026-10-02.
    # Adding an edition requires a reviewed helper update from the official source.
    $catalog = @{
      'fac5c408266d55721bf2888791f01d7d6cc70605227efdcd218e78d53548f2bf' = @{
        id = 'huiyu-resources-20261002-r1'
        source = 'https://github.com/starplatium1129-stack/huiyu/releases/tag/huiyu-resources-20261002-r1'
      }
    }
    $approved = $catalog[$releaseHash]
    if (-not $approved) { throw 'UNTRUSTED_RELEASE: Obtain a current helper from the official independent source. This ZIP is not approved by this helper.' }
    $ExpectedReleaseSha256 = $releaseHash
    $trustedSource = $approved.source
  }
  if ($releaseHash -ne $ExpectedReleaseSha256.ToLowerInvariant()) { throw 'Release approval hash mismatch. Obtain the hash from a trusted publication page.' }
  $release = [Text.Encoding]::UTF8.GetString($releaseBytes) | ConvertFrom-Json
  if ($TrustedRelease -and $release.releaseId -cne $approved.id) { throw 'Trusted release identity mismatch.' }
  if ($release.schemaVersion -ne 1 -or $release.kind -ne 'huiyu-offline-release' -or -not $release.files) { throw 'Unsupported offline release.' }
  $expected = @{}
  $expected['release.json'] = @{ bytes = $releaseBytes.Length; sha256 = $ExpectedReleaseSha256 }
  foreach ($file in $release.files) {
    Check-Cancel
    Assert-EntryPath $file.path
    if ($file.path -notmatch '^(pack|showcase)/' -or $expected.ContainsKey($file.path) -or $file.sha256 -notmatch '^[a-f0-9]{64}$' -or $file.bytes -lt 0 -or [Math]::Floor($file.bytes) -ne $file.bytes) { throw 'Invalid release file inventory.' }
    $expected[$file.path] = $file
  }
  $seen = @{}
  [long]$totalBytes = 0
  foreach ($entry in $zip.Entries) {
    Check-Cancel
    $name = $entry.FullName
    Assert-EntryPath $name
    $unixType = ($entry.ExternalAttributes -shr 16) -band 61440
    if (($unixType -ne 0 -and $unixType -ne 32768) -or ($entry.ExternalAttributes -band 1040)) { throw 'ZIP contains a link, directory or special file.' }
    if ($seen.ContainsKey($name) -or -not $expected.ContainsKey($name) -or $entry.Length -ne $expected[$name].bytes) { throw 'ZIP inventory differs from the approved release.' }
    $seen[$name] = $true
    $totalBytes += $entry.Length
  }
  if ($seen.Count -ne $expected.Count) { throw 'ZIP is incomplete.' }
  # Fail during graphical verification, before inviting the user to install or
  # extracting gigabytes with an incompatible native runtime.
  if ($ProgressState) { Invoke-NativeImport '' -Probe }
  # TEMP may use an 8.3 alias; the native importer requires the physical long path.
  $tempRoot = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Temp')) + '\'
  if ($Apply) {
    Check-Cancel
    if ($ResumeStaging) {
      $staging = Assert-OrdinaryPath $ResumeStaging
      if (-not $staging.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($staging) -notmatch '^huiyu-offline-import-[a-f0-9-]{36}$') { throw 'Unsafe recovery staging.' }
      if ($ProgressState) { $ProgressState.Staging = $staging; $ProgressState.CanResume = $true }
      # The native importer rechecks every retained byte and its complete inventory.
    } else {
      Assert-OrdinaryPath $tempRoot -AllowMissing | Out-Null
      $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($tempRoot))
      if ($drive.AvailableFreeSpace -lt $totalBytes + 65536) { throw 'Insufficient temporary disk space for the approved archive.' }
      $staging = Join-Path $tempRoot ('huiyu-offline-import-' + [Guid]::NewGuid().ToString())
      Assert-OrdinaryPath $staging -AllowMissing | Out-Null
      if (Test-Path -LiteralPath $staging) { throw 'Staging directory already exists.' }
      New-Item -ItemType Directory -Path $staging | Out-Null
      if ($ProgressState) { $ProgressState.Staging = $staging }
    }
  }
  if (($Verify -or $Apply) -and -not $ResumeStaging) {
    [long]$done = 0
    $phase = if ($Apply) { 'extracting' } else { 'verifying' }
    $buffer = New-Object byte[] 65536
    foreach ($entry in $zip.Entries) {
      Check-Cancel
      $outputStream = $null
      if ($Apply) {
        $target = [IO.Path]::GetFullPath((Join-Path $staging $entry.FullName.Replace('/', '\')))
        if (-not $target.StartsWith($staging + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'ZIP target escaped staging.' }
        $parent = [IO.Path]::GetDirectoryName($target)
        Assert-OrdinaryPath $parent -AllowMissing | Out-Null
        [IO.Directory]::CreateDirectory($parent) | Out-Null
        $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
      }
      $inputStream = $null
      $sha = [Security.Cryptography.SHA256]::Create()
      try {
        $inputStream = $entry.Open()
        [long]$copied = 0
        while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
          Check-Cancel
          $copied += $count
          if ($copied -gt $entry.Length) { throw 'ZIP data exceeds approved length.' }
          if ($outputStream) { $outputStream.Write($buffer, 0, $count) }
          $sha.TransformBlock($buffer, 0, $count, $buffer, 0) | Out-Null
          $done += $count
          Report-Progress $phase $done $totalBytes
        }
        if ($copied -ne $entry.Length) { throw 'ZIP data is incomplete.' }
        $sha.TransformFinalBlock($buffer, 0, 0) | Out-Null
        $actual = ([BitConverter]::ToString($sha.Hash)).Replace('-', '').ToLowerInvariant()
        if ($actual -ne $expected[$entry.FullName].sha256) { throw 'Extracted file hash mismatch.' }
        if ($outputStream) { $outputStream.Flush($true) }
      } finally {
        if ($inputStream) { $inputStream.Dispose() }
        if ($outputStream) { $outputStream.Dispose() }
        $sha.Dispose()
      }
    }
  }
  if (-not $Apply) {
    @{ ok=$true; mode='preview'; releaseId=$release.releaseId; appVersion=$release.appVersion; files=$seen.Count;
       bytes=$totalBytes; verified=[bool]$Verify; runtimeRoot=$runtimePath; installDir=$installPath;
       releaseSha256=$ExpectedReleaseSha256; trustedSource=$trustedSource } | ConvertTo-Json
    return
  }
  if ($ProgressState) { $ProgressState.CanResume = $true }
  Check-Cancel
  Report-Progress 'installing' 0 0
  $result = Invoke-NativeImport $staging
  $complete = $true
  $result | ConvertTo-Json -Depth 8
} finally {
  $zip.Dispose()
  if ($staging) {
    if ($complete) {
      try {
        $cleanup = Assert-OrdinaryPath $staging
        if (-not $cleanup.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($cleanup) -notmatch '^huiyu-offline-import-[a-f0-9-]{36}$') { throw 'Unsafe cleanup target.' }
        Remove-Item -LiteralPath $cleanup -Recurse -Force
        if ($ProgressState) { $ProgressState.Staging = $null }
      } catch {
        # The native transaction already confirmed success; leftover scratch data
        # is a cleanup warning, not an installation failure or permission to retry.
        Write-Warning "Installed successfully; temporary files retained: $staging. $_"
      }
      if ($ProgressState) { $ProgressState.CanResume = $false }
    } else { Write-Warning "Incomplete import staging retained: $staging" }
  }
}

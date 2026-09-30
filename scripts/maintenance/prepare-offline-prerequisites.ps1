<#
.SYNOPSIS
Prepare Microsoft's signed x64 Visual C++ Redistributable for offline installation.
.DESCRIPTION
Default: read-only plan. -Apply downloads and verifies material into a new -Out
directory. It never installs or executes downloaded files. A Microsoft signature
authenticates this prerequisite only; it does not authorize any resource pack.
.EXAMPLE
./scripts/maintenance/prepare-offline-prerequisites.ps1 -Out D:/HuiyuRelease/prerequisites
.EXAMPLE
./scripts/maintenance/prepare-offline-prerequisites.ps1 -Out D:/HuiyuRelease/prerequisites -Apply
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Out,
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$sourceUrl = 'https://aka.ms/vc14/vc_redist.x64.exe'
$sourceDocument = 'https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist'
$timeoutSeconds = 180
$maxBytes = 100 * 1024 * 1024

function Assert-PrerequisitePath([string]$Value, [switch]$AllowMissing) {
    $absolute = [IO.Path]::GetFullPath($Value)
    if ($absolute.StartsWith('\\')) { throw 'Network paths are not supported.' }
    $current = $absolute
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked paths are not supported.' }
            if ($current -ne $absolute -and -not $item.PSIsContainer) { throw 'Parent path is not a directory.' }
        } elseif (-not $AllowMissing -and $current -eq $absolute) { throw "Missing path: $absolute" }
        $current = [IO.Path]::GetDirectoryName($current)
    }
    return $absolute
}

function Get-MicrosoftPrerequisiteEvidence([string]$File) {
    $absolute = Assert-PrerequisitePath $File
    if (-not (Test-Path -LiteralPath $absolute -PathType Leaf)) { throw 'Prerequisite must be an ordinary file.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $absolute
    $certificate = $signature.SignerCertificate
    if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or -not $certificate -or
        $certificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)' -or
        $certificate.Subject -notmatch '(^|,\s*)CN=Microsoft Corporation(,|$)') {
        throw "Microsoft Authenticode verification failed: $($signature.Status)"
    }
    $item = Get-Item -LiteralPath $absolute
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($absolute)
    if ($item.Length -lt 1048576 -or $item.Length -gt $maxBytes -or -not $version.FileVersion) {
        throw 'Prerequisite size or file version is invalid.'
    }
    return [ordered]@{
        bytes = $item.Length
        sha256 = (Get-FileHash -LiteralPath $absolute -Algorithm SHA256).Hash.ToLowerInvariant()
        fileVersion = $version.FileVersion
        productVersion = $version.ProductVersion
        productName = $version.ProductName
        signature = [ordered]@{
            status = $signature.Status.ToString()
            signerSubject = $certificate.Subject
            signerThumbprint = $certificate.Thumbprint
            timestampSubject = if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { $null }
        }
    }
}

$outPath = Assert-PrerequisitePath $Out -AllowMissing
if (Test-Path -LiteralPath $outPath) { throw 'Output already exists. Choose a new directory; existing material is never overwritten.' }
$parent = [IO.Path]::GetDirectoryName($outPath)
if (-not $parent -or -not [IO.Path]::GetFileName($outPath)) { throw 'A new output directory with a parent is required.' }
if (-not $Apply) {
    [ordered]@{
        ok = $true
        mode = 'read-only-plan'
        output = $outPath
        sourceUrl = $sourceUrl
        sourceDocument = $sourceDocument
        timeoutSeconds = $timeoutSeconds
        checks = @('Microsoft valid Authenticode signature', 'actual bytes', 'SHA-256', 'file version')
        downloaded = $false
        installed = $false
        note = 'No network requests or writes. -Apply prepares material only; the operator installs it on the target computer.'
    } | ConvertTo-Json -Depth 5
    return
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Microsoft signature verification and atomic publication require Windows.' }
Add-Type -AssemblyName System.Net.Http
Assert-PrerequisitePath $parent -AllowMissing | Out-Null
[IO.Directory]::CreateDirectory($parent) | Out-Null
Assert-PrerequisitePath $parent | Out-Null
$staging = Join-Path $parent ('.' + [IO.Path]::GetFileName($outPath) + '.staging-' + [Guid]::NewGuid().ToString())
Assert-PrerequisitePath $staging -AllowMissing | Out-Null
if (Test-Path -LiteralPath $staging) { throw 'Staging already exists.' }
[IO.Directory]::CreateDirectory($staging) | Out-Null
$handler = New-Object Net.Http.HttpClientHandler
$handler.AllowAutoRedirect = $true
$handler.MaxAutomaticRedirections = 5
$client = New-Object Net.Http.HttpClient($handler)
$client.Timeout = [TimeSpan]::FromSeconds($timeoutSeconds)
$client.DefaultRequestHeaders.UserAgent.ParseAdd('Huiyu-Offline-Prerequisites/1.0')
$cancel = New-Object Threading.CancellationTokenSource
$cancel.CancelAfter([TimeSpan]::FromSeconds($timeoutSeconds))
$response = $null
$inputStream = $null
$outputStream = $null
try {
    $partial = Join-Path $staging 'vc_redist.x64.download.exe'
    $response = $client.GetAsync($sourceUrl, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancel.Token).GetAwaiter().GetResult()
    $response.EnsureSuccessStatusCode() | Out-Null
    $resolved = $response.RequestMessage.RequestUri
    if ($resolved.Scheme -ne 'https' -or $resolved.UserInfo -or
        $resolved.DnsSafeHost -notin @('aka.ms', 'download.visualstudio.microsoft.com', 'download.microsoft.com')) {
        throw 'Prerequisite download left the Microsoft HTTPS source.'
    }
    $declared = $response.Content.Headers.ContentLength
    if ($declared -and ($declared -lt 1048576 -or $declared -gt $maxBytes)) { throw 'Unexpected prerequisite Content-Length.' }
    $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $outputStream = [IO.File]::Open($partial, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    [long]$received = 0
    $buffer = New-Object byte[] 65536
    while (($count = $inputStream.ReadAsync($buffer, 0, $buffer.Length, $cancel.Token).GetAwaiter().GetResult()) -gt 0) {
        $received += $count
        if ($received -gt $maxBytes) { throw 'Prerequisite exceeds the bounded download size.' }
        $outputStream.Write($buffer, 0, $count)
    }
    if ($declared -and $received -ne $declared) { throw 'Prerequisite download is incomplete.' }
    $outputStream.Flush($true)
    $outputStream.Dispose(); $outputStream = $null
    $inputStream.Dispose(); $inputStream = $null
    $evidence = Get-MicrosoftPrerequisiteEvidence $partial
    $target = Join-Path $staging 'vc_redist.x64.exe'
    [IO.File]::Move($partial, $target)
    $utf8 = New-Object Text.UTF8Encoding($false)
    $receipt = [ordered]@{
        schemaVersion = 1
        kind = 'huiyu-offline-prerequisites'
        preparedAt = [DateTime]::UtcNow.ToString('o')
        files = @([ordered]@{
            path = 'vc_redist.x64.exe'
            sourceUrl = $sourceUrl
            resolvedUrl = $resolved.AbsoluteUri
            sourceDocument = $sourceDocument
            bytes = $evidence.bytes
            sha256 = $evidence.sha256
            fileVersion = $evidence.fileVersion
            productVersion = $evidence.productVersion
            productName = $evidence.productName
            signature = $evidence.signature
        })
        installed = $false
        resourcePackApproval = 'not-granted; resource approval still requires its independently trusted release SHA-256'
        redistribution = 'retain Microsoft installer unchanged; review applicable Microsoft distribution terms before public redistribution'
    }
    $receiptBytes = ($receipt | ConvertTo-Json -Depth 8) -replace '\r?\n', "`r`n"
    [IO.File]::WriteAllText((Join-Path $staging 'prerequisites.json'), $receiptBytes + "`r`n", $utf8)
    [IO.File]::WriteAllText((Join-Path $staging 'vc_redist.x64.exe.sha256'), $evidence.sha256 + "  vc_redist.x64.exe`r`n", $utf8)
    $readme = @(
        'HUIYU offline prerequisite: Microsoft Visual C++ v14 x64 Redistributable',
        ('File version: ' + $evidence.fileVersion),
        ('SHA-256: ' + $evidence.sha256),
        'Copy this material with the HUIYU installer and resource ZIP to the target PC.',
        'Verify the file using the checksum from your independently trusted publication.',
        'The user runs vc_redist.x64.exe and handles its license/UAC/restart prompts.',
        'Then install HUIYU, fully exit it, import the resource ZIP and restart.',
        'This preparation script did not install anything or execute the downloaded EXE.',
        'Model weights/environments and WD14 real inference are separate checks.',
        ('Microsoft guidance: ' + $sourceDocument)
    ) -join "`r`n"
    [IO.File]::WriteAllText((Join-Path $staging 'README.txt'), $readme + "`r`n", $utf8)
    $verified = Get-MicrosoftPrerequisiteEvidence $target
    if ($verified.sha256 -ne $evidence.sha256 -or $verified.bytes -ne $evidence.bytes) { throw 'Prepared prerequisite changed during verification.' }
    $recorded = Get-Content -LiteralPath (Join-Path $staging 'prerequisites.json') -Raw | ConvertFrom-Json
    if ($recorded.files[0].sha256 -ne $verified.sha256 -or $recorded.files[0].bytes -ne $verified.bytes) { throw 'Prepared receipt differs from executable bytes.' }
    $cancel.Token.ThrowIfCancellationRequested()
    Assert-PrerequisitePath $staging | Out-Null
    Assert-PrerequisitePath $outPath -AllowMissing | Out-Null
    if (Test-Path -LiteralPath $outPath) { throw 'Output appeared during preparation; publication refused.' }
    [IO.Directory]::Move($staging, $outPath)
    [ordered]@{ ok = $true; mode = 'prepared'; output = $outPath; fileVersion = $verified.fileVersion;
        bytes = $verified.bytes; sha256 = $verified.sha256; signature = $verified.signature.status;
        installed = $false; note = 'Microsoft material prepared only. User installation and target-device checks remain separate.' } | ConvertTo-Json -Depth 5
} catch {
    throw "Prerequisite preparation failed; independent staging retained: $staging. $($_.Exception.Message)"
} finally {
    if ($outputStream) { $outputStream.Dispose() }
    if ($inputStream) { $inputStream.Dispose() }
    if ($response) { $response.Dispose() }
    $client.Dispose()
    $handler.Dispose()
    $cancel.Dispose()
}

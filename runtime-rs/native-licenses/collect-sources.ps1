# Explicitly invoked audit helper, not part of the runtime or installer.
# Fetches only public upstream source archives listed in components.json.
param([string[]]$Only = @())
$ErrorActionPreference = 'Stop'
$auditRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$cache = Join-Path $auditRoot '.downloads'
[IO.Directory]::CreateDirectory($cache) | Out-Null
$manifestFile = Join-Path $auditRoot 'components.json'
$manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json -AsHashtable
$client = [Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromSeconds(40)
$client.DefaultRequestHeaders.UserAgent.ParseAdd('huiyu-native-license-audit')
foreach ($component in $manifest.components) {
    if ($Only.Count -and $component.name -notin $Only) { continue }
    if ($component.sourceVerified -and $component.notices.Count) { continue }
    $component.notices = @()
    $component.errors = @()
    foreach ($uri in $component.sourceUrls) {
        try {
            $archive = Join-Path $cache ($component.name + '.archive')
            $data = if (Test-Path -LiteralPath $archive) { [IO.File]::ReadAllBytes($archive) } else { $client.GetByteArrayAsync($uri).GetAwaiter().GetResult() }
            if ($data.Length -gt 250MB) { throw 'Source archive exceeds 250 MiB audit bound' }
            $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($data)).ToLowerInvariant()
            $component.observedArchive = @{ url=$uri; bytes=$data.Length; sha256=$hash }
            if ($component.expectedSha256 -and $component.expectedSha256 -ne $hash) { throw "Source checksum differs from build recipe: $hash" }
            [IO.File]::WriteAllBytes($archive, $data)
            $entries = & tar.exe -tf $archive 2>$null
            if ($LASTEXITCODE -ne 0) { throw 'Source archive cannot be listed' }
            $selected = @($entries | Where-Object {
                $leaf = ($_ -split '/')[-1]
                $leaf -match '(?i)^(LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE|NOTICES|PATENTS|AUTHORS|FTL)([._-].*)?$' -or
                $_ -match '(?i)/LICENSES/[^/]+$' -or
                $_ -match '/(Cargo.lock|Cargo.toml|subprojects/[^/]+[.]wrap)$'
            })
            foreach ($entry in $selected) {
                $parts = $entry -split '/'
                if ($entry.StartsWith('/') -or $parts -contains '..' -or $entry.Contains(':') -or $entry.Contains('\')) { throw 'Unsafe source entry path' }
                $relative = ($parts | Select-Object -Skip 1) -join '/'
                if (!$relative) { continue }
                $target = [IO.Path]::GetFullPath((Join-Path $auditRoot ('components/' + $component.name + '/' + $relative)))
                if (!$target.StartsWith($auditRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Audit path escaped scope' }
                $start = [Diagnostics.ProcessStartInfo]::new('tar.exe')
                $start.UseShellExecute = $false; $start.CreateNoWindow = $true
                $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
                foreach ($arg in @('-xOf', $archive, $entry)) { $start.ArgumentList.Add($arg) }
                $process = [Diagnostics.Process]::Start($start)
                $buffer = [IO.MemoryStream]::new()
                $errorRead = $process.StandardError.ReadToEndAsync()
                $process.StandardOutput.BaseStream.CopyTo($buffer)
                $process.WaitForExit()
                $stderr = $errorRead.GetAwaiter().GetResult()
                if ($process.ExitCode -ne 0) { throw "Cannot read source notice: $stderr" }
                $notice = $buffer.ToArray(); $buffer.Dispose(); $process.Dispose()
                if ($notice.Length -eq 0) { continue }
                if ($notice.Length -gt 4MB) { throw 'Source notice exceeds 4 MiB audit bound' }
                [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
                [IO.File]::WriteAllBytes($target, $notice)
                $component.notices += @{ file=('components/' + $component.name + '/' + $relative); archiveEntry=$entry; bytes=$notice.Length; sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($notice)).ToLowerInvariant() }
            }
            $component.sourceVerified = [bool]$component.expectedSha256
            $component.sourceStatus = if ($component.sourceVerified) { 'archive-matches-build-recipe' } else { 'version-source-retrieved-no-build-checksum' }
            $component.noticeScope = 'Source-distribution notices; may include optional/tests/vendor code. Not a proof of the complete linked DLL license closure.'
            Write-Output ($component.name + ': ' + $component.sourceStatus + ', ' + $component.notices.Count + ' documents')
            break
        } catch {
            $component.errors += @{ url=$uri; error=$_.Exception.Message }
        }
    }
    if (!$component.notices.Count) { Write-Output ($component.name + ': unresolved') }
    $manifest.retrievedAt = [DateTime]::UtcNow.ToString('o')
    $manifest | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $manifestFile -Encoding utf8NoBOM
}
$client.Dispose()

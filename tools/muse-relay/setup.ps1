param([switch]$CopyToken)
$ErrorActionPreference = 'Stop'
$vault = Join-Path $env:LOCALAPPDATA 'com.aics.studio\muse-relay'
$identity = Join-Path $vault 'connection.clixml'
$connector = Join-Path $env:APPDATA 'com.aics.studio\gateway\muse-relay.json'
$encoding = New-Object Text.UTF8Encoding($false)
function New-Hex([int]$Count) {
    $bytes = New-Object byte[] $Count
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}
function Get-Plain($Value) {
    return ([Net.NetworkCredential]::new('', $Value)).Password
}
if ($CopyToken) {
    $saved = Import-Clixml -LiteralPath $identity
    Set-Clipboard -Value (Get-Plain $saved.Muse)
    Write-Output 'Muse X-Token copied.'
    if (Test-Path -LiteralPath $connector) { (Get-Content -Raw -LiteralPath $connector | ConvertFrom-Json).url }
    return
}

[IO.Directory]::CreateDirectory($vault) | Out-Null
if (!(Test-Path -LiteralPath $identity)) {
    if (Test-Path -LiteralPath $connector) { throw 'A Muse relay is already configured. Keep its original deployment credentials.' }
    $saved = [pscustomobject]@{
        Name = 'huiyu-muse-' + (New-Hex 5)
        Agent = ConvertTo-SecureString (New-Hex 32) -AsPlainText -Force
        Muse = ConvertTo-SecureString (New-Hex 32) -AsPlainText -Force
    }
    $saved | Export-Clixml -LiteralPath $identity -NoClobber
} else { $saved = Import-Clixml -LiteralPath $identity }
$agentToken = Get-Plain $saved.Agent
if (Test-Path -LiteralPath $connector) {
    $old = Get-Content -Raw -LiteralPath $connector | ConvertFrom-Json
    if ($old.agentToken -cne $agentToken) { throw 'The laptop is paired with another relay.' }
}
$secretFile = Join-Path $vault ((New-Hex 12) + '.json')
$env:WRANGLER_SEND_METRICS = 'false'
try {
    [IO.File]::WriteAllText($secretFile, (@{ AGENT_TOKEN=$agentToken; MUSE_TOKEN=(Get-Plain $saved.Muse) } | ConvertTo-Json -Compress), $encoding)
    $config = Join-Path $PSScriptRoot 'wrangler.jsonc'
    & npx.cmd --yes wrangler@4.164.0 deploy --config $config --name $saved.Name --secrets-file $secretFile | Tee-Object -Variable log | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Cloudflare deployment did not finish.' }
    $pattern = 'https://' + [regex]::Escape($saved.Name) + '\.[a-z0-9-]+\.workers\.dev'
    $url = [regex]::Match(($log -join ' '), $pattern, 'IgnoreCase').Value
    if (!$url) { throw 'Wrangler did not return a workers.dev URL. Enable workers.dev in your Cloudflare account and run setup again.' }
} finally {
    if (Test-Path -LiteralPath $secretFile) { Remove-Item -LiteralPath $secretFile }
}
[IO.Directory]::CreateDirectory((Split-Path -Parent $connector)) | Out-Null
$tempConfig = $connector + '.' + (New-Hex 6)
try {
    [IO.File]::WriteAllText($tempConfig, (@{url=$url; agentToken=$agentToken} | ConvertTo-Json -Compress), $encoding)
    if ([IO.File]::Exists($connector)) { [IO.File]::Replace($tempConfig, $connector, [System.Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($tempConfig, $connector) }
} finally { if (Test-Path -LiteralPath $tempConfig) { Remove-Item -LiteralPath $tempConfig } }
Write-Output "Muse HTTPS: $url"
Write-Output 'Copy the Muse X-Token with setup.ps1 -CopyToken.'

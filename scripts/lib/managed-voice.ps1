[CmdletBinding()]
param(
    [ValidateSet('Start', 'Stop', 'Status')][string]$Action = 'Status',
    [ValidateSet('gpt-sovits', 'voxcpm2')][string]$Engine = 'gpt-sovits',
    [Parameter(Mandatory = $true)][string]$AIWorkspaceRoot,
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    [Parameter(Mandatory = $true)][string]$TtsHost
)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath($AIWorkspaceRoot)
$runtimePath = [IO.Path]::GetFullPath($RuntimeRoot)
$appRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$serverPath = Join-Path $appRoot 'tools\voxcpm-server.py'
$pythonPath = Join-Path $workspace 'VoxCPM-env\Scripts\python.exe'
$configPath = Join-Path $runtimePath 'config.json'
$pidFile = Join-Path $runtimePath 'state\managed-voxcpm2.pid'
$stdoutLog = Join-Path $runtimePath 'logs\voxcpm2.stdout.log'
$stderrLog = Join-Path $runtimePath 'logs\voxcpm2.stderr.log'
$uri = [Uri]$TtsHost
if ($uri.Scheme -ne 'http' -or $uri.DnsSafeHost -notin @('127.0.0.1', 'localhost', '::1')) { throw '语音地址必须是本机 HTTP 地址。' }
$listenHost = if ($uri.DnsSafeHost -eq 'localhost') { '127.0.0.1' } else { $uri.DnsSafeHost }
$port = $uri.Port
function Write-Result([bool]$ok, [string]$state, [bool]$managed, [string]$message, [int]$processId = 0) {
    [pscustomobject]@{ ok = $ok; state = $state; managed = $managed; message = $message; pid = $processId } | ConvertTo-Json -Compress
}
function Test-VoiceApi {
    try {
        if ($Engine -eq 'voxcpm2') {
            $health = Invoke-RestMethod -Uri ($TtsHost.TrimEnd('/') + '/health') -TimeoutSec 2
            return $health.online -eq $true -and $health.engine -eq 'VoxCPM2'
        }
        $response = Invoke-WebRequest -UseBasicParsing -Uri ($TtsHost.TrimEnd('/') + '/docs') -TimeoutSec 2
        try {
            $health = Invoke-RestMethod -Uri ($TtsHost.TrimEnd('/') + '/health') -TimeoutSec 2
            if ($health.engine -eq 'VoxCPM2') { return $false }
        } catch {}
        return $response.StatusCode -eq 200
    } catch { return $false }
}
function Test-OwnedProcess($candidate) {
    if (-not $candidate -or -not $candidate.CommandLine) { return $false }
    return $candidate.CommandLine -match [Regex]::Escape($pythonPath) -and
        $candidate.CommandLine -match [Regex]::Escape($serverPath) -and
        $candidate.CommandLine -match [Regex]::Escape($configPath) -and
        $candidate.CommandLine -match ('(?:^|\s)--host\s+' + [Regex]::Escape($listenHost) + '(?:\s|$)') -and
        $candidate.CommandLine -match ('(?:^|\s)--port\s+' + $port + '(?:\s|$)')
}
function Get-OwnedProcess {
    if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) { return $null }
    $savedPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    if ($savedPid -notmatch '^\d+$') { return $null }
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid" -ErrorAction SilentlyContinue
    if (Test-OwnedProcess $candidate) { return $candidate }
    return $null
}
if ($Engine -eq 'gpt-sovits') {
    if ($Action -eq 'Status') { Write-Result $true $(if (Test-VoiceApi) { 'ready' } else { 'stopped' }) $false 'GPT-SoVITS'; exit 0 }
    # Keep the installed GPT startup and weight layout as the existing backup.
    $legacyPath = Join-Path $workspace $(if ($Action -eq 'Start') { 'Voice\Start-Voice.ps1' } else { 'Voice\Stop-Voice.ps1' })
    if ($Action -eq 'Start') { & $legacyPath -WaitSeconds 60 } else { & $legacyPath }
    if (-not $?) { exit 1 }
    Write-Result $true $Action $true '已执行 GPT-SoVITS 服务操作。'; exit 0
}
$owned = Get-OwnedProcess
if ($Action -eq 'Status') {
    $ready = Test-VoiceApi
    Write-Result $true $(if ($ready) { 'ready' } elseif ($owned) { 'starting' } else { 'stopped' }) ([bool]$owned) 'VoxCPM2'; exit 0
}
if ($Action -eq 'Stop') {
    if ($owned) {
        & taskkill.exe /PID $owned.ProcessId /T /F | Out-Null
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
        Write-Result $true 'stopped' $true 'VoxCPM2 已停止，显存已交还系统。'; exit 0
    }
    Write-Result $true 'external-or-stopped' $false '未找到本应用启动的 VoxCPM2；外部服务请从启动它的窗口关闭。'; exit 0
}
if (Test-VoiceApi) { Write-Result $true 'ready' ([bool]$owned) 'VoxCPM2 已就绪。'; exit 0 }
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    Write-Result $false 'port-in-use' $false '语音端口被其他服务占用，请先停止原语音服务或更换地址。'; exit 1
}
if ($owned) { Write-Result $false 'starting' $true 'VoxCPM2 仍在启动，请查看语音日志。'; exit 1 }
foreach ($required in @($pythonPath, $serverPath, $configPath, (Join-Path $workspace 'Voice\models\pretrained\VoxCPM2\model.safetensors'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "缺少 VoxCPM2 本机资源：$required" }
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pidFile), (Split-Path -Parent $stdoutLog) | Out-Null
$arguments = @('-u', ('"{0}"' -f $serverPath), '--ai-root', ('"{0}"' -f $workspace), '--config', ('"{0}"' -f $configPath), '--host', $listenHost, '--port', $port)
$process = Start-Process -FilePath $pythonPath -ArgumentList $arguments -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ASCII
# First torch.compile warmup builds a persistent cache; later starts reuse it.
$deadline = (Get-Date).AddSeconds(360)
do {
    if (Test-VoiceApi) { Write-Result $true 'ready' $true 'VoxCPM2 已启动并通过健康检查。' $process.Id; exit 0 }
    $process.Refresh()
    if ($process.HasExited) { break }
    Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)
$candidate = Get-OwnedProcess
if ($candidate) { & taskkill.exe /PID $candidate.ProcessId /T /F | Out-Null }
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
$detail = if (Test-Path -LiteralPath $stderrLog) { (Get-Content -LiteralPath $stderrLog -Tail 8) -join ' ' } else { '' }
Write-Result $false 'failed' $false ("VoxCPM2 启动失败。绘图占用显存时请先完成绘图，再启动语音。日志：$detail"); exit 1

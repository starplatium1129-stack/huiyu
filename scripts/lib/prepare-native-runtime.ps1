[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Workspace,
  [Parameter(Mandatory=$true)][string]$RuntimeId,
  [Parameter(Mandatory=$true)][string]$CacheDir,
  [switch]$ManagedProtocol
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Resolve-NativePath([string]$path) {
  # Windows PowerShell 5.1 providers cannot reliably join verbatim paths.
  # Convert only disk/UNC spellings; preserve characters such as apostrophes.
  if ($path.StartsWith('\\?\UNC\',[StringComparison]::OrdinalIgnoreCase)) { $path='\\'+$path.Substring(8) }
  elseif ($path.StartsWith('\\?\') -and $path.Substring(4) -match '^[A-Za-z]:\\') { $path=$path.Substring(4) }
  return [IO.Path]::GetFullPath($path)
}
function Get-NativeSha256([string]$path) {
  $stream=[IO.File]::OpenRead($path)
  try {
    $hash=[Security.Cryptography.SHA256CryptoServiceProvider]::new()
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
    finally { $hash.Dispose() }
  } finally { $stream.Dispose() }
}
$scriptRoot=Resolve-NativePath $PSScriptRoot
$appRoot=[IO.Path]::GetFullPath([IO.Path]::Combine($scriptRoot,'../..'))
$manifestName=if ($RuntimeId -eq 'cpython3119-torch290-cu128-images-v2') { 'managed-adapter-runtime.windows-x64.json' } else { 'managed-runtime.windows-x64.json' }
$manifestPath=Join-Path $appRoot ('tools/inference/'+$manifestName)
$manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$manifestHash=Get-NativeSha256 $manifestPath
$requirementsName=if ($RuntimeId -eq 'cpython3119-torch290-cu128-images-v2') { 'requirements-adapters.txt' } else { 'requirements.txt' }
$requirementsHash=Get-NativeSha256 (Join-Path $appRoot ('tools/inference/'+$requirementsName))
if ($manifest.schemaVersion -ne 1 -or $manifest.platform -ne 'win32-x64' -or $RuntimeId -ne $manifest.runtimeId -or $RuntimeId -notmatch '^[a-z0-9][a-z0-9-]{0,79}$') { throw '固定运行库清单或版本标识无效' }
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { throw '原生运行库仅支持 Windows x64；ARM64 与 32 位 Windows 尚不支持' }
if ([Environment]::OSVersion.Version.Build -lt $manifest.minimumWindowsBuild) { throw '此固定运行库支持 Windows 10 22H2 或 Windows 11；请先更新 Windows' }
$workspacePath=Resolve-NativePath $Workspace
$cachePath=Resolve-NativePath $CacheDir
if (-not (Test-Path -LiteralPath $workspacePath -PathType Container)) { throw '请先在绘遇中选择已建立的 AI 工作区' }
function Write-Stage([string]$message) { [Console]::Error.WriteLine($message); [Console]::Error.Flush() }
function Assert-NoLinks([string]$path) {
  $cursor=[IO.Path]::GetFullPath($path)
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('受管运行库不能经过目录链接：'+$cursor) }
    }
    $parent=Split-Path -Parent $cursor
    if ($parent -eq $cursor) { break }
    $cursor=$parent
  }
}
Assert-NoLinks $workspacePath
Assert-NoLinks $cachePath
if (-not $cachePath.StartsWith($workspacePath.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw '运行库缓存必须位于已确认的 AI 工作区内' }
$inferenceRoot=Join-Path $workspacePath 'inference'
$targetRoot=Join-Path $inferenceRoot $RuntimeId
$helper=Join-Path $scriptRoot 'install-native-runtime.py'
Assert-NoLinks $targetRoot
function Invoke-Helper([string]$root) {
  $python=Join-Path $root 'venv/Scripts/python.exe'
  if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw '受管 Python 文件缺失；未覆盖已有目录' }
  $helperArgs=@('-I','-X','utf8','-B','-u',$helper,'--root',$root,'--target-root',$targetRoot,'--cache-dir',$cachePath,'--manifest',$manifestPath)
  # Windows PowerShell 5.1 can surface native progress on its error stream.
  $previousPreference=$ErrorActionPreference
  try { $ErrorActionPreference='Continue'; $output=& $python @helperArgs; $helperExit=$LASTEXITCODE }
  finally { $ErrorActionPreference=$previousPreference }
  if ($helperExit -ne 0) { throw '原生运行库依赖或显卡校验未通过；失败目录保留，已有环境未改动' }
  $document=($output -join "`n") | ConvertFrom-Json
  if ($document.schemaVersion -ne 1 -or $document.engine -ne 'native' -or -not $document.environment.cudaAvailable -or (Resolve-NativePath $document.root) -ne $targetRoot) { throw '原生运行库校验回执不完整' }
  return $document
}
function Read-Runtime([string]$root) {
  $document=Get-Content -LiteralPath (Join-Path $root 'runtime-config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($document.schemaVersion -ne 1 -or $document.engine -ne 'native' -or
      $document.managedRuntimeId -ne $RuntimeId -or $document.manifestSha256 -ne $manifestHash -or $document.requirementsSha256 -ne $requirementsHash -or
      (Resolve-NativePath $document.root) -ne $targetRoot -or
      -not (Test-Path -LiteralPath (Join-Path $root 'venv/Scripts/python.exe') -PathType Leaf)) { throw '运行库安装记录不完整，请重新准备' }
  return $document
}
function VisualCpp-Ready {
  foreach ($key in @('HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64','HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64')) {
    $installed=Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
    if ($installed -and $installed.Installed -eq 1 -and $installed.Version -and [version]($installed.Version.TrimStart('v')) -ge [version]$manifest.minimumVisualCppVersion) { return $true }
  }
  return $false
}
$existingRuntime=Test-Path -LiteralPath $targetRoot
if ($existingRuntime) {
  if (-not (Test-Path -LiteralPath (Join-Path $targetRoot 'runtime-config.json') -PathType Leaf)) { throw '该版本目录已存在但缺少完成记录；请保留并检查冲突目录，不会覆盖' }
}
if ($existingRuntime -and (VisualCpp-Ready)) {
  Write-Stage '采用已安装的受管运行库'
  $document=Read-Runtime $targetRoot
  $document | ConvertTo-Json -Depth 20 -Compress
  exit 0
}
Write-Stage '准备已下载的运行库文件'
foreach ($file in $manifest.files) {
  if ($existingRuntime -and $file.kind -ne 'vc-redist') { continue }
  if ([IO.Path]::GetFileName($file.filename) -ne $file.filename -or $file.sha256 -notmatch '^[0-9a-f]{64}$') { throw '固定资源文件名或 SHA-256 无效' }
  $path=Join-Path $cachePath $file.filename
  Assert-NoLinks $path
  if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -ne $file.bytes) { throw ('下载缓存未完整：'+$file.filename+'。请重新下载此文件后重试。') }
}
$vcFile=@($manifest.files | Where-Object { $_.kind -eq 'vc-redist' })
if ($vcFile.Count -ne 1) { throw '固定清单缺少微软 VC++ x64 运行库' }
if (-not (VisualCpp-Ready)) {
  Write-Stage 'HUIYU:VC_BEGIN'
  try {
    # The gateway freezes cancellation before acknowledging this system phase.
    # An elevated Windows installer must finish or be cancelled in its own UI.
    if ($ManagedProtocol -and [Console]::ReadLine() -ne 'continue') { throw '未获得当前应用安装操作的继续授权；未启动微软安装器' }
    Write-Stage '安装已确认的微软 VC++ x64 共享运行库；请在 Windows UAC 中允许'
    $vcInstaller=Join-Path $cachePath $vcFile[0].filename
    $signature=Get-AuthenticodeSignature -LiteralPath $vcInstaller
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw '微软 VC++ 安装器数字签名无效；已停止' }
    try { $vcProcess=Start-Process -FilePath $vcInstaller -ArgumentList @('/install','/norestart') -Verb RunAs -WindowStyle Normal -PassThru }
    catch { throw '微软 VC++ 安装未获 Windows 授权或启动失败；请重新准备并允许 UAC' }
    $vcProcess.WaitForExit()
    if ($vcProcess.ExitCode -eq 3010 -or $vcProcess.ExitCode -eq 1641) { throw '微软 VC++ 运行库要求重启 Windows。请重启后回到绘遇重新准备；本次尚未标记可用' }
    if ($vcProcess.ExitCode -eq 1602) { throw '微软 VC++ 安装已取消；请重新准备后继续' }
    if ($vcProcess.ExitCode -ne 0 -or -not (VisualCpp-Ready)) { throw ('微软 VC++ 安装失败或版本未就绪，退出码：'+$vcProcess.ExitCode) }
  } finally { Write-Stage 'HUIYU:VC_END' }
}
if ($existingRuntime) {
  Write-Stage '微软共享运行库已就绪，采用已有受管环境'
  $document=Read-Runtime $targetRoot
  $document | ConvertTo-Json -Depth 20 -Compress
  exit 0
}
$stageParent=Join-Path $inferenceRoot '.staging'
Assert-NoLinks $stageParent
New-Item -ItemType Directory -Force -Path $stageParent | Out-Null
$stageRoot=Join-Path $stageParent $RuntimeId
Assert-NoLinks $stageRoot
$ownerPath=Join-Path $stageRoot '.huiyu-candidate.json'
$reuseCandidate=$false
if (Test-Path -LiteralPath $stageRoot) {
  if (-not (Test-Path -LiteralPath $ownerPath -PathType Leaf)) { throw '候选目录缺少绘遇管理标记；未清理或覆盖，请检查目录冲突' }
  Assert-NoLinks $ownerPath
  $owner=Get-Content -LiteralPath $ownerPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($owner.schemaVersion -ne 1 -or $owner.runtimeId -ne $RuntimeId -or $owner.manifestSha256 -ne $manifestHash -or (Resolve-NativePath $owner.targetRoot) -ne $targetRoot) { throw '候选目录的绘遇管理记录不匹配；未清理或覆盖' }
  if (Test-Path -LiteralPath (Join-Path $stageRoot 'runtime-config.json') -PathType Leaf) { $reuseCandidate=$true }
  else {
    # Check every child without following links before recursively deleting only
    # this exact application-owned, uncompleted candidate. Never touch versions.
    $pending=[Collections.Generic.Queue[string]]::new()
    $pending.Enqueue($stageRoot)
    while ($pending.Count -gt 0) {
      foreach ($entry in Get-ChildItem -LiteralPath $pending.Dequeue() -Force) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '未完成候选含目录链接；为保留用户资源已停止清理' }
        if ($entry.PSIsContainer) { $pending.Enqueue($entry.FullName) }
      }
    }
    $resolvedStage=(Get-Item -LiteralPath $stageRoot -Force).FullName
    $expectedStage=[IO.Path]::GetFullPath((Join-Path $workspacePath ('inference/.staging/'+$RuntimeId)))
    if (-not $resolvedStage.Equals($expectedStage,[StringComparison]::OrdinalIgnoreCase)) { throw '候选清理目标不在固定工作区路径内；已停止' }
    Write-Stage '恢复上次中断：仅清理本版本未完成候选，保留下载缓存与已有运行库'
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force
  }
}
if (-not $reuseCandidate) {
  New-Item -ItemType Directory -Path $stageRoot | Out-Null
  @{schemaVersion=1;runtimeId=$RuntimeId;manifestSha256=$manifestHash;targetRoot=$targetRoot} | ConvertTo-Json -Compress | Set-Content -LiteralPath $ownerPath -Encoding UTF8
}
Write-Stage ('准备新的独立版本目录：'+$stageRoot)
try {
  if ($reuseCandidate) { $document=Read-Runtime $stageRoot }
  else {
  $pythonFiles=@($manifest.files | Where-Object { $_.kind -eq 'python' })
  if ($pythonFiles.Count -ne 1) { throw '固定清单缺少唯一的嵌入 Python' }
  $scripts=Join-Path $stageRoot 'venv/Scripts'
  New-Item -ItemType Directory -Path $scripts -Force | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive=[IO.Compression.ZipFile]::OpenRead((Join-Path $cachePath $pythonFiles[0].filename))
  try {
    foreach ($entry in $archive.Entries) {
      if ($entry.FullName -match '(^/|\\|:|(^|/)\.\.(/|$))') { throw '嵌入 Python 包含不安全路径' }
      $destination=[IO.Path]::GetFullPath((Join-Path $scripts $entry.FullName))
      if (-not $destination.StartsWith($scripts.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw '嵌入 Python 路径越界' }
      if ($entry.FullName.EndsWith('/')) { New-Item -ItemType Directory -Path $destination -Force | Out-Null; continue }
      New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$destination,$false)
    }
  } finally { $archive.Dispose() }
  # Embedded Python remains isolated: these are the only module search roots.
  # No system/user site, registry, cwd, PYTHONPATH, pip, or system interpreter.
  [IO.File]::WriteAllText((Join-Path $scripts 'python311._pth'),"python311.zip`n.`n../Lib/site-packages`n",[Text.UTF8Encoding]::new($false))
  New-Item -ItemType Directory -Path (Join-Path $stageRoot 'venv/Lib/site-packages') -Force | Out-Null
  $document=Invoke-Helper $stageRoot
  }
  foreach ($name in @('models','loras')) { New-Item -ItemType Directory -Path (Join-Path $inferenceRoot $name) -Force | Out-Null }
  # Receipt is hidden with the verified candidate until same-volume publication.
  $receiptTemporary=Join-Path $stageRoot '.runtime-config.json.tmp'
  [IO.File]::WriteAllText($receiptTemporary,($document | ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $receiptTemporary -Destination (Join-Path $stageRoot 'runtime-config.json') -Force
  Assert-NoLinks $targetRoot
  if (Test-Path -LiteralPath $targetRoot) { throw '准备期间目标目录发生变化；候选目录保留，未覆盖任何环境' }
  Move-Item -LiteralPath $stageRoot -Destination $targetRoot
  Write-Stage '运行库完整校验并发布；请继续准备模型，再启用原生引擎'
  $document | ConvertTo-Json -Depth 20 -Compress
} catch {
  Write-Stage ('本次未完成目录保留：'+$stageRoot)
  throw
}

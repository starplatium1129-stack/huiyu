[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Workspace,
  [ValidateSet('llama-cuda','llama-vulkan','comfy-nvidia','comfy-cu126','comfy-amd')][string]$Environment,
  [Parameter(Mandatory=$true)][string]$Archive,
  [string]$CudaArchive='',
  [string]$KjArchive='',
  [string]$TeaArchive='',
  [string]$ArchiveSha256=''
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$workspacePath=[IO.Path]::GetFullPath($Workspace)
$setupRoot=Join-Path $workspacePath '.setup'
$stageRoot=Join-Path $setupRoot 'staging'
$stagePath=Join-Path $stageRoot 'environment'
if (-not (Test-Path -LiteralPath $workspacePath -PathType Container)) { throw 'AI 工作区尚未建立' }
function Write-EnvironmentProgress([string]$message,[long]$done=0,[long]$total=0) {
  [Console]::Error.WriteLine(('HUIYU:ENV|'+$done+'|'+$total+'|'+$message))
  [Console]::Error.Flush()
}
$resolvedWorkspace=(Get-Item -LiteralPath $workspacePath).FullName
function Assert-InWorkspace([string]$path) {
  $resolved=[IO.Path]::GetFullPath($path)
  if (-not $resolved.StartsWith($resolvedWorkspace.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw '环境目录越出 AI 工作区' }
  $cursor=$resolved
  while ($cursor -and $cursor.Length -gt $resolvedWorkspace.Length) {
    if (Test-Path -LiteralPath $cursor) {
      $item=Get-Item -LiteralPath $cursor -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '受管环境目录不能通过目录链接写入其他位置' }
    }
    $cursor=Split-Path -Parent $cursor
  }
}
Assert-InWorkspace $stagePath
New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null
if (Test-Path -LiteralPath $stagePath) { Remove-Item -LiteralPath $stagePath -Recurse -Force }
New-Item -ItemType Directory -Path $stagePath | Out-Null
function Expand-Package([string]$source,[string]$destination) {
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw '缺少已经校验的运行包' }
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  Write-EnvironmentProgress ('正在解压：'+[IO.Path]::GetFileName($source))
  & "$env:SystemRoot\System32\tar.exe" -xf $source -C $destination
  if ($LASTEXITCODE -ne 0) { throw '运行包解压失败；请查看日志与 Windows tar 支持情况' }
}
function Find-Directory([string]$root,[string]$file) {
  $found=@(Get-ChildItem -LiteralPath $root -Recurse -File -Filter $file | Where-Object { $file -ne 'main.py' -or $_.Directory.Name -eq 'ComfyUI' })
  if ($found.Count -ne 1) { throw ('运行包入口不唯一：'+$file) }
  return $found[0].Directory.FullName
}
function Install-Node([string]$source,[string]$name,[string]$comfy,[string]$python) {
  $target=Join-Path (Join-Path $comfy 'custom_nodes') $name
  Assert-InWorkspace $target
  if (Test-Path -LiteralPath $target) { throw ('全新运行包中存在冲突节点：'+$name) }
  $nodeStage=Join-Path $stagePath $name
  Expand-Package $source $nodeStage
  $folders=@(Get-ChildItem -LiteralPath $nodeStage -Directory)
  if ($folders.Count -ne 1) { throw '节点包目录布局无效' }
  $nodeRoot=$folders[0].FullName
  if (-not (Test-Path -LiteralPath (Join-Path $nodeRoot '__init__.py') -PathType Leaf)) { throw ('固定节点包缺少入口：'+$name) }
  $requirements=Join-Path $nodeRoot 'requirements.txt'
  if (Test-Path -LiteralPath $requirements) {
    $pipCache=Join-Path $setupRoot 'pip-cache'
    Assert-InWorkspace $pipCache
    $pipSources=@('https://pypi.tuna.tsinghua.edu.cn/simple','https://pypi.org/simple')
    $pipExit=-1
    foreach ($pipSource in $pipSources) {
      Write-EnvironmentProgress ('正在安装节点依赖：'+$name+'，来源：'+$pipSource)
      Write-Output ('安装节点依赖：'+$name+'，来源：'+$pipSource)
      # Native stderr carries retry warnings too. Let pip finish and use its
      # exit code, rather than terminating on PowerShell 5.1 ErrorRecord output.
      $previousPreference=$ErrorActionPreference
      try {
        $ErrorActionPreference='Continue'
        & $python -I -B -m pip install --disable-pip-version-check --cache-dir $pipCache --index-url $pipSource --retries 2 --timeout 30 -r $requirements
        $pipExit=$LASTEXITCODE
      } finally { $ErrorActionPreference=$previousPreference }
      if ($pipExit -eq 0) { break }
      Write-Output ('节点依赖来源未完成，将尝试下一来源；缓存保留：'+$name)
    }
    if ($pipExit -ne 0) { throw ('节点依赖安装失败：'+$name+'；清华镜像和 PyPI 均未完成，请检查网络后重试，已下载缓存保留') }
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Assert-InWorkspace $nodeRoot
  Assert-InWorkspace $target
  Move-Item -LiteralPath $nodeRoot -Destination $target
}

try {
  if ($Environment.StartsWith('llama-')) {
    $target=Join-Path $workspacePath 'Chat\runtime'
    Assert-InWorkspace $target
    if (Test-Path -LiteralPath (Join-Path $target 'llama-server.exe')) {
      Write-Output '{"ok":true,"message":"已有本地聊天运行环境保留"}'
      exit 0
    }
    $unpacked=Join-Path $stagePath 'llama'
    Expand-Package $Archive $unpacked
    $payload=Find-Directory $unpacked 'llama-server.exe'
    if ($CudaArchive) {
      $cudaStage=Join-Path $stagePath 'cuda'
      Expand-Package $CudaArchive $cudaStage
      Get-ChildItem -LiteralPath $cudaStage -Recurse -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $payload $_.Name) }
    }
    if (Test-Path -LiteralPath $target) { throw '聊天运行目录已有其他文件，请在高级设置中核对后重试' }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Assert-InWorkspace $payload
    Assert-InWorkspace $target
    Move-Item -LiteralPath $payload -Destination $target
  } else {
    $managedRoot=Join-Path $workspacePath '.runtimes\comfy'
    Assert-InWorkspace $managedRoot
    if ($ArchiveSha256 -notmatch '^[0-9a-f]{64}$') { throw '运行包缺少发行身份' }
    Expand-Package $Archive (Join-Path $stagePath 'comfy')
    $comfy=Find-Directory (Join-Path $stagePath 'comfy') 'main.py'
    $portableRoot=Split-Path -Parent $comfy
    $python=Join-Path $portableRoot 'python_embeded\python.exe'
    Assert-InWorkspace $comfy
    Assert-InWorkspace $python
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'ComfyUI Portable 目录布局无效' }
    if ($Environment -eq 'comfy-amd') {
      Write-EnvironmentProgress '正在确认 AMD ROCm 与显卡驱动'
      $capability=& $python -I -B -c 'import json,torch; ready=torch.cuda.is_available(); print(json.dumps(dict(huiyuAmdDevice=True,hip=torch.version.hip,available=ready,name=torch.cuda.get_device_name(0) if ready else None)))'
      if ($LASTEXITCODE -ne 0) { throw 'AMD 运行库无法加载，请核对官方 AMD 驱动要求后重试；旧环境已保留' }
      # ROCm may write startup warnings to stdout before our device document.
      # Select only the explicitly identified record, not the combined output.
      $deviceLines=@($capability | Where-Object { $_ -match '^\{"huiyuAmdDevice": true,' })
      if ($deviceLines.Count -ne 1) { throw 'AMD 运行库没有返回有效的设备信息；请查看驱动与依赖日志，旧环境已保留' }
      $device=$deviceLines[0] | ConvertFrom-Json
      if (-not $device.hip -or -not $device.available) { throw '未找到可用的 AMD ROCm 设备，请通过 AMD 官网更新兼容驱动后重试；不会回退到 CPU，旧环境已保留' }
      Write-EnvironmentProgress ('已识别 AMD 设备：'+$device.name+'；真实模型出图仍需确认')
    }
    # Only freshly extracted code is ever run or used to establish a baseline.
    Install-Node $KjArchive 'ComfyUI-KJNodes' $comfy $python
    Install-Node $TeaArchive 'ComfyUI-Anima-TeaCache' $comfy $python
    $runtimes=Split-Path -Parent $managedRoot
    New-Item -ItemType Directory -Force -Path $runtimes | Out-Null
    $preserved=Join-Path $runtimes ('comfy-preserved-'+[Guid]::NewGuid().ToString('N'))
    Assert-InWorkspace $preserved
    $modelRoots=@(Join-Path $workspacePath 'ComfyUI\models')
    # Retain every previous environment wholesale, including user nodes and
    # resources. Only its model directories are made visible to the new code.
    foreach ($backup in Get-ChildItem -LiteralPath $runtimes -Directory -Filter 'comfy-preserved-*') {
      $models=Join-Path $backup.FullName 'ComfyUI\models'
      Assert-InWorkspace $models
      if (Test-Path -LiteralPath $models -PathType Container) { $modelRoots+=,$models }
    }
    if (Test-Path -LiteralPath (Join-Path $managedRoot 'ComfyUI\models') -PathType Container) {
      $modelRoots+=,(Join-Path $preserved 'ComfyUI\models')
    }
    $modelConfig=[ordered]@{}
    for ($index=0; $index -lt $modelRoots.Count; $index++) {
      Assert-InWorkspace $modelRoots[$index]
      $modelConfig['huiyu_models_'+$index]=[ordered]@{
        base_path=$modelRoots[$index]; is_default=($index -eq 0)
        diffusion_models='diffusion_models'; text_encoders='text_encoders'; vae='vae'
        loras='loras'; upscale_models='upscale_models'; checkpoints='checkpoints'
      }
    }
    [IO.File]::WriteAllText((Join-Path $comfy 'extra_model_paths.yaml'),($modelConfig | ConvertTo-Json -Depth 4),[Text.UTF8Encoding]::new($false))
    $receipt=[ordered]@{ schemaVersion=1; environment=$Environment; archiveSha256=$ArchiveSha256 }
    [IO.File]::WriteAllText((Join-Path $portableRoot 'huiyu-environment.json'),($receipt | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
    # The downloaded archive was verified by the preparation owner.
    Write-EnvironmentProgress '正在保存运行环境，保留已有模型与资源'
    # No user files enter staging. Cancellation at any publish boundary leaves
    # them intact in the old location or the preserved directory for the retry.
    Assert-InWorkspace $portableRoot
    Assert-InWorkspace $managedRoot
    Assert-InWorkspace $preserved
    if (Test-Path -LiteralPath $managedRoot) {
      Move-Item -LiteralPath $managedRoot -Destination $preserved
      Write-Output ('原环境与用户资源已保留：'+$preserved)
    }
    try { Move-Item -LiteralPath $portableRoot -Destination $managedRoot }
    catch {
      if (-not (Test-Path -LiteralPath $managedRoot) -and (Test-Path -LiteralPath $preserved)) {
        Assert-InWorkspace $preserved
        Assert-InWorkspace $managedRoot
        Move-Item -LiteralPath $preserved -Destination $managedRoot
      }
      throw
    }
  }
  Write-Output '{"ok":true,"message":"运行环境已准备；加载与真实任务仍需验证"}'
} finally {
  Assert-InWorkspace $stagePath
  if (Test-Path -LiteralPath $stagePath) { Remove-Item -LiteralPath $stagePath -Recurse -Force }
}

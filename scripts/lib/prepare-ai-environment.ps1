[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Workspace,
  [ValidateSet('llama-cuda','llama-vulkan','comfy-nvidia','comfy-cu126')][string]$Environment,
  [Parameter(Mandatory=$true)][string]$Archive,
  [string]$CudaArchive='',
  [string]$KjArchive='',
  [string]$TeaArchive=''
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$workspacePath=[IO.Path]::GetFullPath($Workspace)
$setupRoot=Join-Path $workspacePath '.setup'
$stageRoot=Join-Path $setupRoot 'staging'
$stagePath=Join-Path $stageRoot 'environment'
if (-not (Test-Path -LiteralPath $workspacePath -PathType Container)) { throw 'AI 工作区尚未建立' }
$resolvedWorkspace=(Get-Item -LiteralPath $workspacePath).FullName
New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null
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
if (Test-Path -LiteralPath $stagePath) { Remove-Item -LiteralPath $stagePath -Recurse -Force }
New-Item -ItemType Directory -Path $stagePath | Out-Null
function Expand-Package([string]$source,[string]$destination) {
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw '缺少已经校验的运行包' }
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
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
  if (Test-Path -LiteralPath $target) { return }
  $nodeStage=Join-Path $stagePath $name
  Expand-Package $source $nodeStage
  $folders=@(Get-ChildItem -LiteralPath $nodeStage -Directory)
  if ($folders.Count -ne 1) { throw '节点包目录布局无效' }
  $nodeRoot=$folders[0].FullName
  $requirements=Join-Path $nodeRoot 'requirements.txt'
  if (Test-Path -LiteralPath $requirements) {
    & $python -s -m pip install --disable-pip-version-check --cache-dir (Join-Path $setupRoot 'pip-cache') -r $requirements
    if ($LASTEXITCODE -ne 0) { throw ('节点依赖安装失败：'+$name) }
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
    $comfy=Join-Path $workspacePath 'ComfyUI'
    $python=Join-Path $workspacePath 'python_embeded\python.exe'
    $managedRoot=Join-Path $workspacePath '.runtimes\comfy'
    $publishPortable=$false
    if (-not (Test-Path -LiteralPath (Join-Path $comfy 'main.py'))) {
      $comfy=Join-Path $managedRoot 'ComfyUI'
      $python=Join-Path $managedRoot 'python_embeded\python.exe'
    }
    Assert-InWorkspace $comfy
    Assert-InWorkspace (Split-Path -Parent $python)
    if (-not (Test-Path -LiteralPath (Join-Path $comfy 'main.py'))) {
      Assert-InWorkspace $managedRoot
      if (Test-Path -LiteralPath $managedRoot) { throw '受管运行目录已有不完整环境，请先核对；自动准备不会覆盖未知文件' }
      Expand-Package $Archive (Join-Path $stagePath 'comfy')
      $comfyPayload=Find-Directory (Join-Path $stagePath 'comfy') 'main.py'
      # main.py is at the ComfyUI root; embedded Python is beside it.
      $portableRoot=Split-Path -Parent $comfyPayload
      if (-not (Test-Path -LiteralPath (Join-Path $portableRoot 'python_embeded\python.exe'))) { throw 'ComfyUI Portable 目录布局无效' }
      $comfy=$comfyPayload
      $python=Join-Path $portableRoot 'python_embeded\python.exe'
      $publishPortable=$true
    }
    if (-not (Test-Path -LiteralPath $python)) { $python=Join-Path $comfy 'venv\Scripts\python.exe' }
    if (-not (Test-Path -LiteralPath $python)) { throw '现有 ComfyUI 由外部环境管理，请使用原入口启动；文件保留' }
    Install-Node $KjArchive 'ComfyUI-KJNodes' $comfy $python
    Install-Node $TeaArchive 'ComfyUI-Anima-TeaCache' $comfy $python
    if ($publishPortable) {
      $modelsPath=Join-Path $workspacePath 'ComfyUI\models'
      Assert-InWorkspace $modelsPath
      New-Item -ItemType Directory -Force -Path $modelsPath | Out-Null
      $quotedModels=$modelsPath | ConvertTo-Json -Compress
      $modelConfig=@"
huiyu_models:
  base_path: $quotedModels
  is_default: true
  diffusion_models: diffusion_models
  text_encoders: text_encoders
  vae: vae
  loras: loras
  upscale_models: upscale_models
  checkpoints: checkpoints
"@
      [IO.File]::WriteAllText((Join-Path $comfy 'extra_model_paths.yaml'),$modelConfig,[Text.UTF8Encoding]::new($false))
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $managedRoot) | Out-Null
      # Publish the complete Python + ComfyUI environment together on the same disk.
      Assert-InWorkspace $portableRoot
      Assert-InWorkspace $managedRoot
      Move-Item -LiteralPath $portableRoot -Destination $managedRoot
    }
  }
  Write-Output '{"ok":true,"message":"运行环境已准备；加载与真实任务仍需验证"}'
} finally {
  Assert-InWorkspace $stagePath
  if (Test-Path -LiteralPath $stagePath) { Remove-Item -LiteralPath $stagePath -Recurse -Force }
}

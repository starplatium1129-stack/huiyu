[CmdletBinding()]
param(
    [string]$PythonPath,
    [string]$ModelPath,
    [switch]$Plan
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$aiRoot = if ($env:AI_WORKSPACE_ROOT) { $env:AI_WORKSPACE_ROOT } else { Join-Path (Split-Path -Parent $projectRoot) 'AI' }
if (-not $PythonPath) { $PythonPath = if ($env:TRANSLATION_PYTHON) { $env:TRANSLATION_PYTHON } else { Join-Path $aiRoot 'GPT-SoVITS-env\python.exe' } }
if (-not $ModelPath) { $ModelPath = if ($env:AICS_TRANSLATION_MODEL) { $env:AICS_TRANSLATION_MODEL } else { Join-Path $aiRoot 'Voice\models\translation\m2m100_418m' } }
$PythonPath = [IO.Path]::GetFullPath($PythonPath)
$ModelPath = [IO.Path]::GetFullPath($ModelPath)
$revision = '55c2e61bbf05dfb8d7abccdc3fae6fc8512fd636'

if ($Plan) {
    [pscustomobject]@{ repository = 'facebook/m2m100_418M'; revision = $revision; python = $PythonPath; target = $ModelPath; weightsBytes = 1935796948; dependencies = @('huggingface_hub', 'torch', 'transformers', 'sentencepiece'); inference = 'not-run' } | ConvertTo-Json
    return
}

if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
    throw "Translation Python environment was not found: $PythonPath"
}

# Paths are arguments, never interpolated into Python code. The pinned release supplies
# pytorch_model.bin only; revisit this snapshot when upstream publishes safetensors.
& $PythonPath -c @'
import hashlib, sys
from pathlib import Path
from huggingface_hub import snapshot_download
target, revision = sys.argv[1:]
files = ['config.json', 'generation_config.json', 'pytorch_model.bin', 'vocab.json', 'sentencepiece.bpe.model', 'tokenizer_config.json', 'README.md']
snapshot_download('facebook/m2m100_418M', revision=revision, local_dir=target, allow_patterns=files)
expected = {'pytorch_model.bin': (1935796948, 'd907ea45e4e4b9db163382a6674f6218b3c59566fe06d77f4055c208b4e87ed1'), 'sentencepiece.bpe.model': (2423393, 'd8f7c76ed2a5e0822be39f0a4f95a55eb19c78f4593ce609e2edbc2aea4d380a')}
for name in files:
    path = Path(target) / name
    if not path.is_file() or not path.stat().st_size:
        raise RuntimeError('Incomplete translation snapshot: ' + name)
    if name in expected:
        size, digest = expected[name]
        checksum = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                checksum.update(chunk)
        actual = checksum.hexdigest()
        if path.stat().st_size != size or actual != digest:
            raise RuntimeError('Translation model checksum mismatch: ' + name)
print('Snapshot files verified; validate local_files_only loading on the target device: ' + target)
'@ $ModelPath $revision
if ($LASTEXITCODE -ne 0) { throw "Translation snapshot failed (exit $LASTEXITCODE)" }

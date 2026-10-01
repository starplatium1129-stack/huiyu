import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { ModelFile } from './model-download-manifest'
import manifest from '../../tools/interrogate/pixai-manifest.json'
import { matchesModel } from './model-download'

export const PIXAI_MANIFEST = manifest
export const PIXAI_FILES: readonly ModelFile[] = manifest.files.map(entry => ({
  ...entry, repo: manifest.repo, revision: manifest.revision, remotePath: entry.path,
}))
export const TIMM_FILE: ModelFile = {
  path: manifest.timm.path, repo: '', revision: manifest.timm.version,
  remotePath: manifest.timm.path, bytes: manifest.timm.bytes, sha256: manifest.timm.sha256,
  sourceUrl: manifest.timm.url,
}

export async function adoptCandidate(source: string, target: string): Promise<void> {
  const files = [
    ...PIXAI_FILES.map(file => ({ ...file, path: path.join('model', file.path) })),
    { ...TIMM_FILE, path: path.join('wheels', TIMM_FILE.path) },
  ]
  for (const file of files) {
    const destination = path.join(target, file.path)
    if (await matchesModel(destination, file)) continue
    if (fs.existsSync(destination)) throw Error(`Existing PixAI target differs from pinned bytes: ${file.path}`)
    const origin = path.join(source, file.path)
    if (!await matchesModel(origin, file)) throw Error(`Candidate differs from pinned bytes: ${file.path}`)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    if (file.path.endsWith('model.safetensors')) {
      try { fs.linkSync(origin, destination); continue } catch (error) {
        if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP'].includes(String((error as NodeJS.ErrnoException).code))) throw error
      }
    }
    fs.copyFileSync(origin, destination, fs.constants.COPYFILE_EXCL)
  }
}

export async function pythonJson(python: string, code: string, args: string[] = []): Promise<Record<string, any>> {
  const child = spawn(python, ['-B', '-c', code, ...args], { windowsHide: true, shell: false,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  const timeout = setTimeout(() => child.kill(), 30_000)
  const stop = () => child.kill()
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  try {
    return await new Promise((resolve, reject) => {
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString('utf8')
        if (stdout.length > 64 * 1024) { child.kill(); reject(Error('Python preparation response exceeds 64 KiB')) }
      })
      child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString('utf8')).slice(-64 * 1024) })
      child.once('error', reject)
      child.once('close', code => {
        if (code !== 0) reject(Error(`PixAI Python environment is unavailable: ${stderr.trim() || code}`))
        else {
          try { resolve(JSON.parse(stdout.trim()) as Record<string, any>) } catch { reject(Error('Python environment returned invalid JSON')) }
        }
      })
    })
  } finally {
    clearTimeout(timeout); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
  }
}

export async function resolvePython(python: string, torchSite?: string): Promise<{ python: string; pythonVersion: string; torchSitePackages: string }> {
  const info = await pythonJson(python, [
    'import sys,sysconfig,json',
    'assert sys.version_info >= (3, 11), f"PixAI requires Python 3.11 or newer; selected {sys.version.split()[0]}"',
    'print(json.dumps({"python":getattr(sys,"_base_executable",sys.executable),"pythonVersion":sys.version.split()[0],"site":sysconfig.get_path("purelib")}))',
  ].join('\n'))
  if (typeof info.python !== 'string' || typeof info.site !== 'string' || typeof info.pythonVersion !== 'string') throw Error('Python environment returned invalid paths or version')
  return { python: path.resolve(info.python), pythonVersion: info.pythonVersion, torchSitePackages: path.resolve(torchSite || info.site) }
}

export async function checkPython(python: string, site: string, deps: string): Promise<Record<string, any>> {
  return pythonJson(python, [
    'import sys,json,importlib.metadata as m',
    'assert sys.version_info >= (3, 11), f"PixAI requires Python 3.11 or newer; selected {sys.version.split()[0]}"',
    'sys.path[:0]=[sys.argv[1],sys.argv[2]]',
    'import torch,torchvision,timm,numpy,PIL,safetensors',
    'from timm.layers import DropPath,trunc_normal_',
    'from transformers import BaseImageProcessor,Pipeline,PretrainedConfig,PreTrainedModel,TensorType',
    'assert m.version("timm")=="1.0.30","PixAI requires the pinned timm 1.0.30 target"',
    'assert torch.version.cuda is not None,"PyTorch has no CUDA build"',
    'assert torch.cuda.is_available(),"CUDA GPU is unavailable"',
    'print(json.dumps({"pythonVersion":sys.version.split()[0],"versions":{n:m.version(n) for n in ["torch","torchvision","transformers","timm","numpy","Pillow","safetensors"]},"cuda":torch.version.cuda,"gpuAvailable":True}))',
  ].join('\n'), [deps, site])
}

export async function installTimm(python: string, root: string): Promise<void> {
  const deps = path.join(root, 'deps')
  const existing = path.join(deps, `timm-${manifest.timm.version}.dist-info`, 'METADATA')
  if (fs.existsSync(existing) && fs.existsSync(path.join(deps, 'timm', '__init__.py'))) return
  if (fs.existsSync(path.join(deps, 'timm'))) throw Error('Existing PixAI timm target is incomplete or a different version; choose a separate target directory')
  await pythonJson(python, [
    'import runpy,sys,json,contextlib',
    'target,wheel=sys.argv[1:3]',
    'sys.argv=["pip","install","--disable-pip-version-check","--no-index","--no-deps","--no-compile","--target",target,wheel]',
    'try:',
    ' with contextlib.redirect_stdout(sys.stderr):runpy.run_module("pip",run_name="__main__")',
    'except SystemExit as error:',
    ' if error.code:raise',
    'print(json.dumps({"installed":"timm","version":"1.0.30"}))',
  ].join('\n'), [deps, path.join(root, 'wheels', TIMM_FILE.path)])
}

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { officialUrl } from '../lib/model-download-manifest'
import { downloadPlan, matchesModel, runModelDownloads } from '../lib/model-download'
import { adoptCandidate, checkPython, installTimm, PIXAI_FILES, PIXAI_MANIFEST, resolvePython, TIMM_FILE } from '../lib/pixai-prepare'
import { errorMessage } from '../lib/runtime-errors'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    if (['--help', '--plan', '--check'].includes(argument)) flags.add(argument)
    else if (['--target-dir', '--python', '--torch-site-packages', '--reuse-from'].includes(argument)) {
      const value = args[++index]
      if (!value || value.startsWith('--') || values.has(argument)) throw Error(`${argument} requires one path`)
      values.set(argument, value)
    } else throw Error(`Unknown PixAI preparation argument: ${argument}`)
  }
  if (flags.has('--help')) {
    console.log('models:prepare-pixai [--target-dir <writable runtime root>] [--python <existing Python/venv>] [--torch-site-packages <existing torch site>] [--reuse-from <existing candidate root>] [--plan|--check]\nRequires Python 3.11 or newer; checked before downloads or dependency installation.\nFixed official PixAI v1.0 model (~1.81 GiB) and timm 1.0.30. Reuses verified files; installs timm only in target/deps.\n--plan: no network/writes/process. --check: local integrity/dependency checks, no install/inference; reuses Python/Torch paths from the target receipt unless CLI/environment paths override them. Production Python/Comfy settings are not changed.')
    return
  }
  if (flags.has('--plan') && flags.has('--check')) throw Error('Choose --plan or --check')
  const appRoot = path.resolve(__dirname, '../..')
  const root = path.resolve(values.get('--target-dir') || path.join(process.env.AICS_RUNTIME_ROOT || path.join(appRoot, 'runtime'), 'pixai'))
  const modelDir = path.join(root, 'model'), depsDir = path.join(root, 'deps')
  const aiRoot = process.env.AI_WORKSPACE_ROOT || path.resolve(appRoot, '../AI')
  const defaultPython = path.join(aiRoot, 'ComfyUI/venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  let requestedPython = values.get('--python') || process.env.AICS_PIXAI_PYTHON
  let requestedSite = values.get('--torch-site-packages') || process.env.AICS_PIXAI_TORCH_SITE_PACKAGES
  if (flags.has('--plan')) {
    console.log(JSON.stringify({ ...downloadPlan(modelDir, PIXAI_FILES, officialUrl), checkedAt: PIXAI_MANIFEST.checkedAt,
      dependency: TIMM_FILE, depsDir, requestedPython: requestedPython || defaultPython, reuseFrom: values.get('--reuse-from') || null, requestedSite: requestedSite || 'discovered from existing Python',
      scope: 'fixed files and isolated timm target; no production environment install',
      receipt: path.join(root, 'runtime-config.json'), inference: 'unverified by preparation; offline CUDA BF16, 3 GiB torch allocator' }, null, 2))
    return
  }
  if (flags.has('--check')) {
    const savedPath = path.join(root, 'runtime-config.json')
    if (fs.existsSync(savedPath)) {
      let saved: { schemaVersion?: number; python?: string; torchSitePackages?: string }
      try { saved = JSON.parse(fs.readFileSync(savedPath, 'utf8')) }
      catch (error) { throw Error(`Cannot read PixAI saved configuration: ${savedPath}`, { cause: error }) }
      if (saved?.schemaVersion !== 1 || typeof saved.python !== 'string' || !path.isAbsolute(saved.python)
        || typeof saved.torchSitePackages !== 'string' || !path.isAbsolute(saved.torchSitePackages)) {
        throw Error(`Invalid PixAI saved configuration: ${savedPath}`)
      }
      requestedPython ||= saved.python
      requestedSite ||= saved.torchSitePackages
    }
  }
  const python = await resolvePython(requestedPython || defaultPython, requestedSite)
  if (flags.has('--check')) {
    for (const file of PIXAI_FILES) {
      if (!await matchesModel(path.join(modelDir, file.path), file)) throw Error(`PixAI file missing or differs from fixed metadata: ${file.path}`)
    }
    if (!await matchesModel(path.join(root, 'wheels', TIMM_FILE.path), TIMM_FILE)) throw Error('PixAI timm wheel is missing or differs from fixed metadata')
  } else {
    if (values.has('--reuse-from')) await adoptCandidate(path.resolve(values.get('--reuse-from')!), root)
    await runModelDownloads(modelDir, PIXAI_FILES, officialUrl)
    await runModelDownloads(path.join(root, 'wheels'), [TIMM_FILE], officialUrl)
    await installTimm(python.python, root)
  }
  const environment = await checkPython(python.python, python.torchSitePackages, depsDir)
  const receipt = { schemaVersion: 1, engine: 'pixai', model: 'pixai-tagger-v1.0', revision: PIXAI_MANIFEST.revision,
    modelSha256: PIXAI_FILES.find(file => file.path === 'model.safetensors')!.sha256,
    ...python, modelDir, depsDir, workerScript: path.join(appRoot, 'tools/interrogate/pixai_worker.py'),
    files: PIXAI_FILES, dependency: { ...TIMM_FILE, installedTo: depsDir }, environment }
  if (flags.has('--check')) { console.log(JSON.stringify({ ok: true, checkedOnly: true, ...receipt }, null, 2)); return }
  const target = path.join(root, 'runtime-config.json'), temporary = `${target}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
    fs.renameSync(temporary, target)
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
  console.log(JSON.stringify({ ok: true, config: target, ...receipt }, null, 2))
  console.log('PixAI 本机文件与依赖已核验。GPU 模型按 runtime 生命周期保持，准备命令没有执行推理。')
}

if (require.main === module) void main().catch(error => {
  console.error(errorMessage(error)); if (process.exitCode !== 130) process.exitCode = 1
})

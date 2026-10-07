import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { COMFY_KNOWN_FILES, officialUrl, type ModelFile } from '../lib/model-download-manifest'
import { matchesModel } from '../lib/model-download'
import { errorMessage } from '../lib/runtime-errors'
import pixaiManifest from '../../tools/interrogate/pixai-manifest.json'

interface FileCheck {
  path: string
  state: 'missing' | 'file-present' | 'bytes-match' | 'sha256-match' | 'size-mismatch' | 'hash-mismatch'
  bytes?: number
  expectedBytes?: number
  source?: string
}

export async function inspectModelFile(root: string, relative: string, known?: ModelFile, hashes = false): Promise<FileCheck> {
  const file = path.resolve(root, relative)
  const result: FileCheck = { path: relative, state: 'missing' }
  if (known) { result.expectedBytes = known.bytes; if (known.repo || known.sourceUrl) result.source = officialUrl(known) }
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || !stat.size) return result
    result.bytes = stat.size
    result.state = !known ? 'file-present' : stat.size === known.bytes ? 'bytes-match' : 'size-mismatch'
    if (known && hashes && result.state === 'bytes-match') result.state = await matchesModel(file, known) ? 'sha256-match' : 'hash-mismatch'
    return result
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return result
  }
}

function detectGpu(): { name: string; vramMiB: number }[] {
  try {
    const output = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, windowsHide: true,
    })
    return output.trim().split(/\r?\n/).flatMap(line => {
      const [name, memory] = line.split(',')
      return name && Number(memory) > 0 ? [{ name: name.trim(), vramMiB: Number(memory) }] : []
    })
  } catch { return [] }
}

function directoryPresent(file: string): boolean {
  try { return fs.statSync(file).isDirectory() } catch { return false }
}

async function inspectPixai(appRoot: string, runtimeRoot: string, aiRoot: string, env: NodeJS.ProcessEnv, hashes: boolean) {
  const root = path.join(runtimeRoot, 'pixai')
  const candidates = env.AICS_PIXAI_CONFIG !== undefined ? [path.resolve(env.AICS_PIXAI_CONFIG)]
    : [path.join(root, 'runtime-config.json'), path.join(aiRoot, 'PixAI/runtime-config.json')]
  const receipt: { path: string; state: 'missing' | 'loaded' | 'invalid'; reason?: string } = { path: candidates[0]!, state: 'missing' }
  let saved: Record<'python' | 'modelDir' | 'depsDir' | 'torchSitePackages', string> | undefined
  // Mirror runtime-rs/src/interrogate/settings.rs: an existing invalid receipt
  // stops fallback; explicit environment paths still override saved/default paths.
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue
    receipt.path = candidate
    try {
      const value = JSON.parse(fs.readFileSync(candidate, 'utf8'))
      if (value?.schemaVersion !== 1 || !['python', 'modelDir', 'depsDir', 'torchSitePackages']
        .every(key => typeof value[key] === 'string' && path.isAbsolute(value[key]))) throw Error('Expected schemaVersion 1 and absolute PixAI paths')
      saved = value
      receipt.state = 'loaded'
    } catch (error) { receipt.state = 'invalid'; receipt.reason = errorMessage(error) }
    break
  }
  const selected = (variable: string, key: keyof NonNullable<typeof saved>, fallback: string) =>
    path.resolve(env[variable] ?? saved?.[key] ?? path.join(root, fallback))
  const paths = {
    python: selected('AICS_PIXAI_PYTHON', 'python', 'unconfigured/python.exe'),
    modelDir: selected('AICS_PIXAI_MODEL_DIR', 'modelDir', 'model'),
    depsDir: selected('AICS_PIXAI_DEPS_DIR', 'depsDir', 'deps'),
    torchSitePackages: selected('AICS_PIXAI_TORCH_SITE_PACKAGES', 'torchSitePackages', 'torch'),
  }
  return { engine: 'pixai', revision: pixaiManifest.revision, receipt, paths,
    files: await Promise.all(pixaiManifest.files.map(file => inspectModelFile(paths.modelDir, file.path,
      { ...file, repo: pixaiManifest.repo, revision: pixaiManifest.revision, remotePath: file.path }, hashes))),
    python: await inspectModelFile(path.dirname(paths.python), path.basename(paths.python)),
    worker: await inspectModelFile(appRoot, 'tools/interrogate/pixai_worker.py'),
    manifest: await inspectModelFile(appRoot, 'tools/interrogate/pixai-manifest.json'),
    dependencies: { timm: await inspectModelFile(paths.depsDir, 'timm/__init__.py'),
      torch: await inspectModelFile(paths.torchSitePackages, 'torch/__init__.py') },
    pythonPackages: 'not-probed; Python >=3.11, pinned timm and CUDA torch plus worker imports still require environment acceptance',
    gpu: 'not-probed; CUDA, BF16 and free VRAM require device acceptance' }
}

export async function checkModels(appRoot: string, env: NodeJS.ProcessEnv = process.env, hashes = false, probeHardware = true) {
  appRoot = path.resolve(appRoot)
  const aiRoot = path.resolve(env.AI_WORKSPACE_ROOT || path.join(appRoot, '..', 'AI'))
  const runtimeRoot = path.resolve(env.AICS_RUNTIME_ROOT || path.join(appRoot, 'runtime'))
  const runtimeComfyRoot = path.join(aiRoot, 'ComfyUI', 'models')
  const comfyRoot = path.resolve(env.COMFYUI_MODELS_ROOT || runtimeComfyRoot)
  const known = new Map(COMFY_KNOWN_FILES.map(entry => [entry.path, entry]))
  const checked = new Map<string, Promise<FileCheck>>()
  const inspect = (relative: string) => {
    if (!checked.has(relative)) checked.set(relative, inspectModelFile(comfyRoot, relative, known.get(relative), hashes))
    return checked.get(relative)!
  }
  // These embedded catalogs are the product Rust runtime's exact model requirements.
  const images = JSON.parse(fs.readFileSync(path.join(appRoot, 'runtime-rs/src/images/catalog.json'), 'utf8'))
  const endfield = JSON.parse(fs.readFileSync(path.join(appRoot, 'runtime-rs/src/images/endfield-lora.json'), 'utf8'))
  images.LORAS[endfield.id] = { file: endfield.file }
  const video = JSON.parse(fs.readFileSync(path.join(appRoot, 'runtime-rs/src/video/catalog.json'), 'utf8')).constants
  const imageModels = []
  for (const [id, model] of Object.entries(images.MODELS) as [string, { file: string; family: string; noLora?: boolean }][]) {
    imageModels.push({ id, family: model.family, noLora: model.noLora === true,
      files: await Promise.all([`diffusion_models/${model.file}`, `text_encoders/${model.family === 'krea2' ? 'qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors' : 'qwen_3_06b_base.safetensors'}`, 'vae/qwen_image_vae.safetensors'].map(inspect)) })
  }
  const videoModels = []
  for (const model of video.MODEL_CATALOG as { id: string; executable: boolean; requirements: string[][] }[]) {
    videoModels.push({ id: model.id, adapter: model.executable ? 'implemented-device-unverified' : 'unavailable',
      files: await Promise.all(model.requirements.map(parts => inspect(parts.join('/')))) })
  }
  const loras = await Promise.all([...Object.values(images.LORAS), ...Object.values(images.KREA_STYLE_LORAS)]
    .map(model => inspect(`loras/${(model as { file: string }).file}`)))
  const pixai = await inspectPixai(appRoot, runtimeRoot, aiRoot, env, hashes)
  const nativeManifest = JSON.parse(fs.readFileSync(path.join(appRoot, 'runtime-rs/native-dependencies.windows-x64.json'), 'utf8'))
  const nativeFiles = await Promise.all((nativeManifest.files as { name: string; source: string; bytes: number; sha256: string }[]).map(entry => {
    const file = env.AICS_VIPS_DYLIB_PATH || (fs.existsSync(path.join(appRoot, 'native', entry.name)) ? path.join(appRoot, 'native', entry.name) : path.join(appRoot, entry.source))
    return inspectModelFile(path.dirname(file), path.basename(file), { path: entry.name, remotePath: '', repo: '', revision: '', bytes: entry.bytes, sha256: entry.sha256 }, hashes)
  }))
  const translationRoot = path.resolve(env.AICS_TRANSLATION_MODEL || path.join(aiRoot, 'Voice/models/translation/m2m100_418m'))
  const translationFiles = await Promise.all(['config.json', 'pytorch_model.bin', 'vocab.json', 'sentencepiece.bpe.model', 'tokenizer_config.json']
    .map(relative => inspectModelFile(translationRoot, relative)))
  const python = env.TRANSLATION_PYTHON || path.join(aiRoot, 'GPT-SoVITS-env/python.exe')
  let voiceConfig: { ttsEngine?: string; voices?: Record<string, { refAudioPath?: string; promptText?: string; gptWeightsPath?: string; sovitsWeightsPath?: string; loraWeightsPath?: string }> } = {}
  try { voiceConfig = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'config.json'), 'utf8')) || {} } catch {}
  const voiceEngine = voiceConfig.ttsEngine === 'voxcpm2' ? 'voxcpm2' : 'gpt-sovits'
  const voiceProfiles = []
  for (const id of ['nene', 'natsume']) {
    const profile = voiceConfig.voices?.[id] || {}
    const files = voiceEngine === 'voxcpm2' ? [profile.refAudioPath, profile.loraWeightsPath]
      : [profile.refAudioPath, profile.gptWeightsPath, profile.sovitsWeightsPath]
    voiceProfiles.push({ id, engine: voiceEngine, referenceTextConfigured: Boolean(profile.promptText?.trim()),
      files: await Promise.all(files.map(file => file
        ? inspectModelFile(path.dirname(file), path.basename(file)) : Promise.resolve({ path: 'not-configured', state: 'missing' as const }))) })
  }
  const ollamaRoot = env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama/models')
  return { checkedAt: new Date().toISOString(), verification: hashes ? 'file bytes and known SHA-256 only' : 'file presence and known sizes only',
    inference: 'not-run', upstreamNodes: 'not-probed', performance: 'device-unverified',
    roots: { appRoot, runtimeRoot, aiRoot, comfyRoot, runtimeComfyRoot, gatewayPathMatchesScan: path.resolve(comfyRoot) === path.resolve(runtimeComfyRoot) },
    hardware: { ramGiB: Math.round(os.totalmem() / 1073741824), cpu: os.cpus()[0]?.model || 'unknown', gpus: probeHardware ? detectGpu() : [] },
    pixai, nativeFiles, imageModels, videoModels, loras,
    wai: await inspect('checkpoints/waiIllustriousSDXL_v170.safetensors'),
    waiLoras: await Promise.all(['ayachi_nene_v18_wd14.safetensors', 'shiki_natsume_v18_wd14.safetensors'].map(name => inspect(`loras/${name}`))),
    translation: { directory: translationRoot, files: translationFiles, python: await inspectModelFile(path.dirname(python), path.basename(python)), pythonPackages: 'not-probed; torch, transformers and sentencepiece required' },
    voiceProfiles, ollama: { directory: ollamaRoot, blobs: directoryPresent(path.join(ollamaRoot, 'blobs')), manifests: directoryPresent(path.join(ollamaRoot, 'manifests')), modelUsability: 'not-probed; verify local model using ollama list' },
    onlineOnly: ['remote API models', 'Ollama cloud models', 'public sharing/tunnel', 'initial downloads and updates'] }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('--plan')) {
    console.log('models:check [--json] [--verify-hashes]\nRead-only inventory: Rust model catalogs, PixAI files/environment paths, native DLLs, voice/translation, Ollama cache.\nPixAI follows AICS_PIXAI_CONFIG, runtime/pixai then AI/PixAI receipts, and AICS_PIXAI_PYTHON/MODEL_DIR/DEPS_DIR/TORCH_SITE_PACKAGES overrides.\nSet AICS_APP_ROOT, AI_WORKSPACE_ROOT, AICS_TRANSLATION_MODEL as appropriate.\nCOMFYUI_MODELS_ROOT changes this scan only; runtime uses AI_WORKSPACE_ROOT/ComfyUI/models.\n--verify-hashes reads large weights. Does not load models, import Python packages, start services or certify inference.')
    return
  }
  if (args.some(arg => !['--json', '--verify-hashes'].includes(arg))) throw Error('Unknown models:check argument; use --help')
  const report = await checkModels(process.env.AICS_APP_ROOT || path.resolve(__dirname, '../..'), process.env, args.includes('--verify-hashes'))
  console.log(JSON.stringify(report, null, 2))
  if (!args.includes('--json')) console.log('\n文件状态只表示当前字节；请按 docs/guides/setup-and-models.md 完成断网真实功能验收。')
}

if (require.main === module) void main().catch(error => { console.error(errorMessage(error)); process.exitCode = 1 })

import { readInput, readStdin, submit } from './muse.mjs'
import { saveAll, saveOriginal } from './download.mjs'
import { isTerminalItem, waitForBatch } from './wait.mjs'
import { uploadImage } from './upload.mjs'

const UPLOADED_IMAGE_HANDLE = /^aics_anima_input_[A-Za-z0-9_.-]+\.(?:png|jpe?g|webp)$/i

export const drawingTextOptions = {
  model: 'modelId', upscale: 'upscale', 'moss-sampler': 'mossSampler', 'moss-acceleration': 'mossAcceleration',
  'style-lora': 'styleLoraId',
}
export const drawingIntegerOptions = ['seed', 'variants', 'width', 'height', 'grow-mask-by']
export const drawingNumberOptions = {
  'tea-cache-thresh': { field: 'teaCacheThresh', max: 1 },
  'moss-spectrum-flex-window': { field: 'mossSpectrumFlexWindow', max: 2 },
  denoise: { field: 'denoisingStrength', min: 0.1, max: 1 },
  'mask-threshold': { field: 'maskThreshold', min: 0.05, max: 0.95 },
}
export const promptTextOptions = {
  negative: 'negative', character: 'character', lora: 'loraId',
  operation: 'operation', 'pen-lines-polarity': 'penLinesPolarity', 'pen-lines-fit': 'penLinesFit',
}
export const sharedControlOptions = [
  'init-image', 'ref', 'mask', 'mask-prompt', 'sketch-file', 'regions-file', 'layout-file',
]
export const drawingOptions = [
  ...Object.keys(drawingTextOptions), ...drawingIntegerOptions, 'tea-cache', ...Object.keys(drawingNumberOptions),
  ...sharedControlOptions,
]
export const drawingHelp = '通用选项包括 --model 模型ID、--seed 种子、--variants 张数、--width 宽 --height 高、--upscale off|ultrasharp|remacri、--style-lora 风格LoRA。\n'
  + '    进阶控制支持 --init-image 底图、--ref 参考图（可多次传）、--mask 蒙版图或 --mask-prompt 蒙版提示词、--mask-threshold 0.05–0.95、--grow-mask-by 0–32、--denoise 0.1–1.0、--sketch-file 线稿JSON、--regions-file 分区JSON、--layout-file MOSS布局JSON。\n'
  + '    底图/参考图/蒙版支持已上传文件名或本地图片路径（自动 SHA-256 复用或上传）。\n'
  + '    Anima 加速用 --tea-cache on|off 和 --tea-cache-thresh 0–1；MOSS 加速用 --moss-sampler euler|er-sde、--moss-acceleration off|spectrum|spectrum-adaptive 和 --moss-spectrum-flex-window 0–2。'

export function inferUploadFamily(options, input) {
  const kind = options.kind ?? input?.kind
  const model = (options.model ?? input?.modelId ?? '').toLowerCase()
  if (kind === 'manga' || model === 'manga-screen') return 'manga'
  if (model.startsWith('qwen')) return 'qwen'
  if (model.startsWith('flux-kontext') || model.startsWith('minimax-h3')) return 'keyframe'
  if (model.startsWith('moss')) return 'moss'
  if (model.startsWith('krea2')) return 'krea2'
  return 'anima'
}

export async function resolveImageHandle(value, family) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('图片参数不能为空。')
  const trimmed = value.trim()
  if (UPLOADED_IMAGE_HANDLE.test(trimmed)) return trimmed
  return (await uploadImage(trimmed, { family })).name
}

export function drawingOverrides(options) {
  const payload = {}
  for (const [flag, field] of Object.entries(drawingTextOptions)) {
    if (options[flag] !== undefined) payload[field] = options[flag]
  }
  for (const field of drawingIntegerOptions) {
    const raw = options[field]
    if (raw === undefined) continue
    const value = Number(raw)
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) throw new Error(`--${field} 需要非负整数。`)
    if (field === 'grow-mask-by') {
      if (value > 32) throw new Error('--grow-mask-by 需要 0–32 的整数。')
      payload.growMaskBy = value
    } else {
      payload[field] = value
    }
  }
  for (const [flag, { field, min = 0, max }] of Object.entries(drawingNumberOptions)) {
    const raw = options[flag]
    if (raw === undefined) continue
    const value = Number(raw)
    if (!raw.trim() || !Number.isFinite(value) || value < min || value > max) throw new Error(`--${flag} 需要 ${min}–${max} 的数值。`)
    payload[field] = value
  }
  if (options['mask-prompt'] !== undefined) payload.maskPrompt = options['mask-prompt']
  const teaCache = options['tea-cache']
  if (teaCache !== undefined) {
    if (teaCache !== 'on' && teaCache !== 'off') throw new Error('--tea-cache 需要 on 或 off。')
    payload.teaCache = teaCache === 'on'
    if (teaCache === 'off' && options['tea-cache-thresh'] === undefined) payload.teaCacheThresh = undefined
  }
  return payload
}

export async function resolveControlOverrides(options, input, overrides, batch) {
  const family = inferUploadFamily(options, input)
  if (options['init-image'] !== undefined) {
    overrides.initImage = await resolveImageHandle(options['init-image'], family)
  }
  if (options.mask !== undefined) {
    overrides.maskImage = await resolveImageHandle(options.mask, family)
  }
  if (options.ref !== undefined) {
    const refs = []
    for (const value of options.ref) {
      refs.push(await resolveImageHandle(value, family))
    }
    overrides.referenceImages = refs
  }
  if (!batch && options['pen-lines'] !== undefined) {
    overrides.penLines = await resolveImageHandle(options['pen-lines'], 'manga')
  }
  if (options['sketch-file'] !== undefined) {
    const sketch = await readInput(options['sketch-file'], false)
    if (!sketch || typeof sketch !== 'object' || Array.isArray(sketch)) {
      throw new Error('--sketch-file 须包含一个 JSON 对象。')
    }
    if (typeof sketch.image === 'string' && sketch.image.trim() && !UPLOADED_IMAGE_HANDLE.test(sketch.image.trim())) {
      sketch.image = (await uploadImage(sketch.image.trim(), { family })).name
    }
    overrides.sketchControl = sketch
  }
  if (options['regions-file'] !== undefined) {
    const regions = await readInput(options['regions-file'], false)
    if (!Array.isArray(regions)) throw new Error('--regions-file 须包含一个 JSON 数组。')
    overrides.regions = regions
  }
  if (options['layout-file'] !== undefined) {
    const loaded = await readInput(options['layout-file'], false)
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
      throw new Error('--layout-file 须包含一个 MOSS 布局 JSON 对象或反推结果 JSON。')
    }
    const baseLayout = loaded.assistLayout && typeof loaded.assistLayout === 'object' ? loaded.assistLayout : loaded
    const hasCaption = (typeof baseLayout.caption === 'string' && baseLayout.caption.trim())
      || (typeof baseLayout.summary?.caption === 'string' && baseLayout.summary.caption.trim())
    overrides.layout = !hasCaption && loaded.assistLayout && typeof loaded.caption === 'string' && loaded.caption.trim()
      ? { ...baseLayout, caption: loaded.caption.trim() }
      : baseLayout
  }
}

export function buildFromInterrogate(data, modelId) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('--from-interrogate 须为反推结果 JSON 对象。')
  }
  const model = (modelId ?? '').toLowerCase()
  const isNatural = model.startsWith('moss') || model.startsWith('krea2') || model.startsWith('qwen')
    || model.startsWith('flux') || model.startsWith('minimax')
  const tagsPrompt = Array.isArray(data.tags) && data.tags.length
    ? data.tags.filter(t => typeof t === 'string' && t.trim()).join(', ')
    : undefined
  const captionPrompt = typeof data.caption === 'string' && data.caption.trim() ? data.caption.trim() : undefined
  const prompt = isNatural ? (captionPrompt ?? tagsPrompt) : (tagsPrompt ?? captionPrompt)
  const result = {}
  if (prompt) result.prompt = prompt
  if (data.assistLayout && typeof data.assistLayout === 'object' && (!model || model.startsWith('moss'))) {
    if (model.startsWith('moss')) result.layout = data.assistLayout
  }
  if (!result.prompt && !result.layout) {
    throw new Error('反推 JSON 中未找到可用的 tags、caption 或 assistLayout。')
  }
  return result
}

export function promptOptions(options) {
  const payload = {}
  for (const [option, field] of Object.entries(promptTextOptions)) {
    if (options[option] !== undefined) payload[field] = options[option]
  }
  if (options.steps !== undefined) payload.steps = positiveInteger(options.steps, '--steps')
  if (options.cfg !== undefined) payload.cfg = finiteNumber(options.cfg, '--cfg')
  if (options['lora-strength'] !== undefined) {
    const strength = finiteNumber(options['lora-strength'], '--lora-strength')
    if (strength < 0 || strength > 2) throw new Error('--lora-strength 需要 0–2 的数值。')
    payload.loraStrength = strength
  }
  return payload
}

export function finiteNumber(raw, label) {
  const value = Number(raw)
  if (!raw.trim() || !Number.isFinite(value)) throw new Error(`${label} 需要有限数值。`)
  return value
}

export function positiveInteger(raw, label) {
  const value = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} 需要正整数。`)
  return value
}

export function waitTimeout(raw) {
  if (raw === undefined) return undefined
  const value = positiveInteger(raw, '--timeout')
  if (value > 2_147_483) throw new Error('--timeout 最多为 2147483 秒。')
  return value
}

export async function drawingInput(options, args, batch) {
  if (batch) {
    const fromFile = args.length > 0
    const fromIds = options.ids !== undefined
    if (fromFile === fromIds) throw new Error('请指定批量 JSON 文件、- 或 --ids。')
    if (args.length) return readInput(args[0], true)
    const ids = options.ids.flatMap(value => value.split(',').map(id => id.trim()))
    if (ids.some(id => !id)) throw new Error('--ids 中的每个目录 ID 都不能为空。')
    return { ids }
  }
  const isManga = options.kind === 'manga' || options.model === 'manga-screen'
  const sources = ['id', 'file'].filter(key => options[key] !== undefined)
  if (options.prompt !== undefined && options['from-interrogate'] === undefined) sources.push('prompt')
  if (options['from-interrogate'] !== undefined) sources.push('from-interrogate')
  const hasStandaloneControl = Boolean(options.outfit) || Boolean(options['layout-file'])
    || (isManga && options['init-image'] !== undefined)
  if (sources.length > 1 || (!sources.length && !hasStandaloneControl)) {
    throw new Error('请选 --id、--prompt、--file、--from-interrogate 中的一项，或传 --outfit / --layout-file / 漫画模式 --init-image。')
  }
  if (options.file !== undefined) return readInput(options.file, false)
  if (options.id !== undefined) return { id: options.id }
  if (options['from-interrogate'] !== undefined) {
    const data = await readInput(options['from-interrogate'], false)
    const extracted = buildFromInterrogate(data, options.model)
    if (options.prompt !== undefined) {
      extracted.prompt = options.prompt === '-' ? await readStdin(64 * 1024, '提示词') : options.prompt
    }
    return extracted
  }
  if (options.prompt === '-') return { prompt: await readStdin(64 * 1024, '提示词') }
  return options.prompt === undefined ? {} : { prompt: options.prompt }
}

export async function saveOneResult(receipt, output, options) {
  const item = receipt.items?.[0]
  const result = { saved: [], pending: [], failed: [] }
  if (item?.resultAvailable === true) {
    try { result.saved.push(await saveOriginal(receipt, 1, output, options)) }
    catch (error) { result.failed.push({ item: 1, status: item.status, code: error.code ?? 'OUTPUT_FAILED', error: error.message }) }
  } else {
    const rows = item && isTerminalItem(item) ? result.failed : result.pending
    rows.push({ item: 1, status: item?.status, deliveryStatus: item?.deliveryStatus, code: item?.code, error: item?.error })
  }
  return result
}

export async function drawOrBatch(options, args, session, batch) {
  const output = batch ? options['out-dir'] : options.out
  const shouldWait = options.wait || output !== undefined
  const timeout = waitTimeout(options.timeout)
  if (timeout !== undefined && !shouldWait) throw new Error('--timeout 需要搭配 --wait 或输出路径。')
  if (options['single-connection'] && output === undefined) throw new Error('--single-connection 需要输出路径。')
  if (output !== undefined && (!output.trim() || (!batch && !/\.png$/i.test(output)))) {
    throw new Error(batch ? '--out-dir 需要目录路径。' : '--out 需要 .png 文件路径。')
  }

  const overrides = drawingOverrides(options)
  if (!batch) {
    if (options.kind !== undefined) {
      if (!['scene', 'blueprint', 'outfit', 'prompt', 'manga'].includes(options.kind)) {
        throw new Error('--kind 须为 scene、blueprint、outfit、prompt 或 manga。')
      }
      overrides.kind = options.kind
    }
    if (options.outfit !== undefined) overrides.outfitId = options.outfit
    Object.assign(overrides, promptOptions(options))
  }
  const input = await drawingInput(options, args, batch)
  await resolveControlOverrides(options, input, overrides, batch)
  if (!batch && output !== undefined && (overrides.variants ?? input?.variants ?? 1) !== 1) {
    throw new Error('--out 只能保存一张图。多张图请用 batch --out-dir。')
  }
  const submitted = await submit(input, options.key, batch, overrides)
  session.last = submitted.batchKey
  if (!shouldWait) return submitted

  try {
    const receipt = await waitForBatch(submitted.batchKey, { timeout, initial: submitted })
    if (output === undefined) return receipt
    const saveOptions = { singleConnection: options['single-connection'] }
    if (batch) return { ...receipt, ...await saveAll(receipt, output, saveOptions) }
    return { ...receipt, ...await saveOneResult(receipt, output, saveOptions) }
  } catch (error) {
    error.requestKey = submitted.batchKey
    throw error
  }
}

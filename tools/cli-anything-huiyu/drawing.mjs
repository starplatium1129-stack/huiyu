import { api, readInput, readStdin, submit } from './muse.mjs'
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
  'style-lora-strength': { field: 'styleLoraStrength', min: -2, max: 2 },
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
  'cast', 'cast-file', 'formation', 'interaction',
]
export const drawingOptions = [
  ...Object.keys(drawingTextOptions), ...drawingIntegerOptions, 'tea-cache', ...Object.keys(drawingNumberOptions),
  ...sharedControlOptions, 'style-loras',
]
export const drawingHelp = '通用选项包括 --model 模型ID、--seed 种子、--variants 张数、--width 宽 --height 高、--upscale off|ultrasharp|remacri、--style-lora 风格ID、--style-lora-strength=-0.5（范围 -2 至 2，默认 1）。--style-loras 可传最多两项的 JSON 数组，每项含 id 与 strength。\n'
  + '    同框（1–5 人）支持重复传 --cast 角色[:服装ID|=自定义服装|none][:动作] 或 --cast-file JSON（原创角色使用对象 name/appearance/gender；服装可传 outfitPrompt 或 outfitId:"none"，另支持 ≤600 字 action 和 MOSS 归一化 bbox）。--interaction 描述对视或共用物品等互动；--formation 支持 row|close|staggered。--prompt 写共享环境/光影/镜头。\n'
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

export async function resolveImageHandle(value, family, preview = false) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('图片参数不能为空。')
  const trimmed = value.trim()
  if (UPLOADED_IMAGE_HANDLE.test(trimmed)) return trimmed
  if (preview) throw new Error('预览请传已上传的图片文件名。')
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
  if (options['style-loras'] !== undefined) {
    const styles = JSON.parse(options['style-loras'])
    if (!Array.isArray(styles) || styles.length > 2) throw new Error('--style-loras 需要最多两个风格的 JSON 数组。')
    payload.styleLoras = styles
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

export async function resolveControlOverrides(options, input, overrides, batch, preview = false) {
  const family = inferUploadFamily(options, input)
  if (options['init-image'] !== undefined) {
    overrides.initImage = await resolveImageHandle(options['init-image'], family, preview)
  }
  if (options.mask !== undefined) {
    overrides.maskImage = await resolveImageHandle(options.mask, family, preview)
  }
  if (options.ref !== undefined) {
    const refs = []
    for (const value of options.ref) {
      refs.push(await resolveImageHandle(value, family, preview))
    }
    overrides.referenceImages = refs
  }
  if (!batch && options['pen-lines'] !== undefined) {
    overrides.penLines = await resolveImageHandle(options['pen-lines'], 'manga', preview)
  }
  if (options['sketch-file'] !== undefined) {
    const sketch = await readInput(options['sketch-file'], false)
    if (!sketch || typeof sketch !== 'object' || Array.isArray(sketch)) {
      throw new Error('--sketch-file 须包含一个 JSON 对象。')
    }
    if (typeof sketch.image === 'string' && sketch.image.trim()) {
      sketch.image = await resolveImageHandle(sketch.image, family, preview)
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
  await resolveCastOverrides(options, overrides)
}

function parseCastSpec(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('--cast 成员不能为空。')
  const firstColon = raw.indexOf(':')
  if (firstColon < 0) return { characterId: raw.trim() }
  const characterId = raw.slice(0, firstColon).trim()
  if (!characterId) throw new Error('--cast 缺少角色 ID，格式为 角色ID[:服装ID|=自定义服装|none][:动作]。')
  const rest = raw.slice(firstColon + 1)
  const secondColon = rest.indexOf(':')
  const outfitPart = (secondColon < 0 ? rest : rest.slice(0, secondColon)).trim()
  const action = secondColon < 0 ? '' : rest.slice(secondColon + 1).trim()
  const member = { characterId }
  if (outfitPart.startsWith('=')) {
    const customOutfit = outfitPart.slice(1).trim()
    if (!customOutfit) throw new Error('--cast 中 = 后需要填写自定义服装描述。')
    member.outfitPrompt = customOutfit
    member.outfitExplicit = true
  } else if (outfitPart) {
    member.outfitId = outfitPart
    member.outfitExplicit = true
  }
  if (action) member.action = action
  return member
}

async function resolveCastOverrides(options, overrides) {
  if (options.cast !== undefined && options['cast-file'] !== undefined) {
    throw new Error('--cast 和 --cast-file 请只选一个。')
  }
  if (options.cast !== undefined) {
    const members = options.cast.map(parseCastSpec)
    if (!members.length || members.length > 5) throw new Error('--cast 支持 1–5 名角色。')
    overrides.cast = members
  } else if (options['cast-file'] !== undefined) {
    const loaded = await readInput(options['cast-file'], false)
    if (!Array.isArray(loaded) || !loaded.length || loaded.length > 5) {
      throw new Error('--cast-file 须包含 1–5 名角色的 JSON 数组。')
    }
    overrides.cast = loaded.map(item => typeof item === 'string' ? parseCastSpec(item) : item)
  }
  if (options.formation !== undefined) {
    if (!['row', 'close', 'intimate', 'staggered'].includes(options.formation)) {
      throw new Error('--formation 仅支持 row、close 或 staggered。')
    }
    overrides.formation = options.formation === 'intimate' ? 'close' : options.formation
  }
  if (options.interaction !== undefined) {
    const items = options.interaction.map(text => text.trim()).filter(Boolean)
    if (!items.length) throw new Error('--interaction 不能为空。')
    overrides.interaction = items.length === 1 ? items[0] : items
  }
}

export function buildFromInterrogate(data, modelId, hasCast = false) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('--from-interrogate 须为反推结果 JSON 对象。')
  }
  const model = (modelId ?? '').toLowerCase()
  const isNatural = model.startsWith('moss') || model.startsWith('krea2') || model.startsWith('qwen')
    || model.startsWith('flux') || model.startsWith('minimax')
  const strings = value => Array.isArray(value) ? value.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim()) : []
  const referenceTags = strings(data.tags)
  const tagsPrompt = referenceTags.join(', ') || undefined
  const captionPrompt = typeof data.caption === 'string' && data.caption.trim() ? data.caption.trim() : undefined
  const prompt = isNatural ? (captionPrompt ?? tagsPrompt) : (tagsPrompt ?? captionPrompt)
  const result = {}
  const hasAssistLayout = Boolean(data.assistLayout && typeof data.assistLayout === 'object')
  if (hasAssistLayout && (model.startsWith('moss') || hasCast && (!model || model.startsWith('anima')))) {
    const baseLayout = data.assistLayout
    const hasLayoutCaption = (typeof baseLayout.caption === 'string' && baseLayout.caption.trim())
      || (typeof baseLayout.summary?.caption === 'string' && baseLayout.summary.caption.trim())
    const layout = !hasLayoutCaption && captionPrompt
      ? { ...baseLayout, caption: captionPrompt }
      : baseLayout
    if (model.startsWith('moss')) result.layout = layout
    else result.referenceLayout = layout
  }
  if (hasCast && (prompt || result.layout || result.referenceLayout)) {
    if (referenceTags.length) result.referenceTags = referenceTags
    if (captionPrompt) result.referenceCaption = captionPrompt
    const names = [...new Set([...strings(data.characterTags), ...strings(data.copyrightTags)])]
    if (names.length) result.referenceIdentityTerms = names
  } else if (prompt) result.prompt = prompt
  if (!result.prompt && !result.layout && !result.referenceLayout && !result.referenceCaption && !result.referenceTags) {
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
  const hasCast = Boolean(options.cast?.length || options['cast-file'] !== undefined)
  const sources = ['id', 'file'].filter(key => options[key] !== undefined)
  if (options.prompt !== undefined && options['from-interrogate'] === undefined && !(hasCast && options.id !== undefined)) {
    sources.push('prompt')
  }
  if (options['from-interrogate'] !== undefined) sources.push('from-interrogate')
  const hasStandaloneControl = Boolean(options.outfit) || Boolean(options['layout-file'])
    || hasCast || (isManga && options['init-image'] !== undefined)
  if (sources.length > 1 || (!sources.length && !hasStandaloneControl)) {
    throw new Error('请选 --id、--prompt、--file、--from-interrogate 中的一项，或传 --cast / --outfit / --layout-file / 漫画模式 --init-image。')
  }
  if (options.file !== undefined) return readInput(options.file, false)
  if (options.id !== undefined) {
    const result = { id: options.id }
    if (hasCast && options.prompt !== undefined) {
      result.prompt = options.prompt === '-' ? await readStdin(64 * 1024, '提示词') : options.prompt
    }
    return result
  }
  if (options['from-interrogate'] !== undefined) {
    const data = await readInput(options['from-interrogate'], false)
    const extracted = buildFromInterrogate(data, options.model, hasCast)
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
  if (input?.dryRun !== undefined && typeof input.dryRun !== 'boolean') throw new Error('dryRun 须为布尔值。')
  const preview = options['dry-run'] === true || input?.dryRun === true
  if (preview && (batch || shouldWait || options.key !== undefined)) {
    throw new Error('单图预览请使用 draw --dry-run，省略 --wait、--out 和 --key。')
  }
  await resolveControlOverrides(options, input, overrides, batch, preview)
  if (preview) return previewDrawing(input, overrides)
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

export async function previewDrawing(input, overrides) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('预览参数须为 JSON 对象。')
  const payload = { ...input, ...overrides }
  delete payload.dryRun
  delete payload.requestKey
  return api('POST', '/api/muse/jobs/preview', payload)
}

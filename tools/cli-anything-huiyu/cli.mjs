#!/usr/bin/env node
import { log, table } from 'node:console'
import { createInterface } from 'node:readline/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect, parseArgs } from 'node:util'
import { api, agentName, newRequestKey, readInput, readStdin, requestKey, submit } from './muse.mjs'
import { doctor, errorsFrom, failure, guide, models, status } from './diagnostics.mjs'
import { saveAll, saveOriginal } from './download.mjs'
import { isTerminalItem, readBatch, waitForBatch } from './wait.mjs'
import { runVoice, voiceCommand, voiceStatus, voiceSynthesize } from './voice.mjs'
import { desktopCommand, qqCommand, runDesktop, runQq } from './channels.mjs'
import { runUpload, uploadCommand, uploadImage } from './upload.mjs'
import { runVideo, videoCancel, videoCommand, videoConcat, videoJob, videoStatus } from './video.mjs'
import { galleryCommand, galleryList, galleryShow, healthCommand, runGallery, runHealth } from './gallery.mjs'
import { interrogateCommand, interrogateJson, interrogateStatus, runInterrogate, runUpscale, submitUpscale, upscaleCommand } from './interrogate.mjs'
import tool from './tool.json' with { type: 'json' }

const UPLOADED_IMAGE_HANDLE = /^aics_anima_input_[A-Za-z0-9_.-]+\.(?:png|jpe?g|webp)$/i
const SCOPED_ALLOWED_ACTIONS = new Set(['status', 'key', 'catalog', 'detail', 'models', 'draw', 'batch', 'upscale', 'job', 'errors', 'cancel'])
const BATCH_KEY_ACTIONS = new Set([
  'job', 'errors', 'cancel', 'save', 'draw', 'batch', 'upscale',
  'interrogate', 'voice_say', 'video_create', 'video_job', 'video_cancel', 'video_batch', 'video_concat',
])

const drawingTextOptions = {
  model: 'modelId', upscale: 'upscale', 'moss-sampler': 'mossSampler', 'moss-acceleration': 'mossAcceleration',
  'style-lora': 'styleLoraId',
}
const drawingIntegerOptions = ['seed', 'variants', 'width', 'height', 'grow-mask-by']
const drawingNumberOptions = {
  'tea-cache-thresh': { field: 'teaCacheThresh', max: 1 },
  'moss-spectrum-flex-window': { field: 'mossSpectrumFlexWindow', max: 2 },
  denoise: { field: 'denoisingStrength', min: 0.1, max: 1 },
  'mask-threshold': { field: 'maskThreshold', min: 0.05, max: 0.95 },
}
const promptTextOptions = {
  negative: 'negative', character: 'character', lora: 'loraId',
  operation: 'operation', 'pen-lines-polarity': 'penLinesPolarity', 'pen-lines-fit': 'penLinesFit',
}
const sharedControlOptions = [
  'init-image', 'ref', 'mask', 'mask-prompt', 'sketch-file', 'regions-file', 'layout-file',
]
const drawingOptions = [
  ...Object.keys(drawingTextOptions), ...drawingIntegerOptions, 'tea-cache', ...Object.keys(drawingNumberOptions),
  ...sharedControlOptions,
]
const drawingHelp = '通用选项包括 --model 模型ID、--seed 种子、--variants 张数、--width 宽 --height 高、--upscale off|ultrasharp|remacri、--style-lora 风格LoRA。\n'
  + '    进阶控制支持 --init-image 底图、--ref 参考图（可多次传）、--mask 蒙版图或 --mask-prompt 蒙版提示词、--mask-threshold 0.05–0.95、--grow-mask-by 0–32、--denoise 0.1–1.0、--sketch-file 线稿JSON、--regions-file 分区JSON、--layout-file MOSS布局JSON。\n'
  + '    底图/参考图/蒙版支持已上传文件名或本地图片路径（自动 SHA-256 复用或上传）。\n'
  + '    Anima 加速用 --tea-cache on|off 和 --tea-cache-thresh 0–1；MOSS 加速用 --moss-sampler euler|er-sde、--moss-acceleration off|spectrum|spectrum-adaptive 和 --moss-spectrum-flex-window 0–2。'

const commands = {
  invoke: { about: '从标准输入读取 huiyu_drawing 工具参数 JSON。用 --json help invoke 读取工具定义。', tool },
  status: { about: '检查配置的出图机连接。HTTPS 中转会分别返回中转可达性和出图机在线状态。' },
  guide: { about: '读取出图机的 Muse 接口说明。' },
  models: { usage: '[--model 模型ID] [--character 角色]', options: ['model', 'character'], about: '查看模型、默认尺寸、LoRA、放大权重和加速支持。' },
  doctor: { about: '检查连接、凭据格式、出图机状态和支持的能力。' },
  key: { about: '生成可跨助手传递的请求编号，提交与重试使用同一个编号。HUIYU_CLI_AGENT 可设置助手名前缀。' },
  catalog: {
    usage: '[--kind 类型] [--search 关键词] [--character 角色] [--category 分类] [--rating 分级] [--page 页码] [--page-size 条数]',
    about: '搜索角色、服装、场景和蓝图。kind 可用 media、scene、blueprint、character、outfit。',
    options: ['kind', 'search', 'character', 'category', 'rating', 'page', 'page-size'],
  },
  detail: { usage: '类型 ID', args: 2, about: '读取角色、服装或场景配方详情，保留 ID 中的斜杠。' },
  draw: {
    usage: '(--id 目录ID | --outfit 服装ID | --prompt 文本或- | --file JSON或- | --from-interrogate 反推JSON | --layout-file 布局JSON | --init-image 底图) [出图选项] [--key 编号] [--wait] [--timeout 秒] [--out PNG]',
    about: `提交单图或变体。--id 可配合 --outfit 换装，--kind 指定 scene、blueprint、outfit、prompt 或 manga；Krea 2 目录配方支持 --style-lora；--from-interrogate 自动读取反推 JSON 的 tags/caption/assistLayout。--out 等待并保存一张原图。\n    自定义提示词可用 --negative、--steps、--cfg、--character、--lora、--lora-strength；漫画网点（manga-screen）可用 --operation、--pen-lines、--pen-lines-polarity、--pen-lines-fit。保存时可用 --single-connection。\n    ${drawingHelp}`,
    options: ['id', 'outfit', 'kind', 'prompt', 'file', 'from-interrogate', 'key', 'wait', 'timeout', 'out', 'single-connection', ...drawingOptions,
      ...Object.keys(promptTextOptions), 'steps', 'cfg', 'lora-strength', 'pen-lines'],
    booleans: ['wait', 'single-connection'],
    multiple: ['ref'],
  },
  batch: {
    usage: '(批量.json | - | --ids ID1,ID2) [出图选项] [--key 编号] [--wait] [--timeout 秒] [--out-dir 目录]', args: 1, minArgs: 0,
    about: `批次含变体最多 16 张。可重复传 --ids，也可用 - 从标准输入读 JSON。各项自己的设置优先于整批默认值。保存时可用 --single-connection。\n    ${drawingHelp}`,
    options: ['ids', 'key', 'wait', 'timeout', 'out-dir', 'single-connection', ...drawingOptions],
    booleans: ['wait', 'single-connection'],
    multiple: ['ids', 'ref'],
  },
  upload: uploadCommand,
  interrogate: interrogateCommand,
  upscale: upscaleCommand,
  queue: { about: '查看当前队列与进度。' },
  recent: { usage: '[--agent 助手名] [--status 状态] [--since 起点] [--before 游标] [--limit 条数]', about: '查看近期任务，用 nextBefore 翻页。', options: ['agent', 'status', 'since', 'before', 'limit'] },
  errors: { usage: '[批次编号 | --agent 助手名] [--since 起点] [--before 游标] [--limit 条数]', minArgs: 0, args: 1,
    about: '按批次查每张图的生成和交付错误，或筛选一页历史记录。历史结果用 nextBefore 翻页。', options: ['agent', 'since', 'before', 'limit'] },
  job: { usage: '批次编号', args: 1, about: '按提交回执的 batchKey 查看每一张的状态。' },
  wait: { usage: '批次编号 [--item 序号] [--timeout 秒] [--interval 秒]', args: 1,
    about: '等任务或交付结束。默认等 300 秒，每次查询间隔至少 2 秒。超时会返回当前回执和批次编号。', options: ['item', 'timeout', 'interval'] },
  cancel: { usage: '批次编号 [--item 序号]', args: 1, about: '取消整批或指定的单张，序号从 1 开始。', options: ['item'] },
  save: { usage: '批次编号 (目标.png [--item 序号] | 输出目录 --all) [--single-connection]', args: 2,
    about: '校验并保存原图。默认取第一张，也可保存整批已就绪的原图。', options: ['item', 'all', 'single-connection'],
    booleans: ['all', 'single-connection'] },
  voice: voiceCommand,
  desktop: desktopCommand,
  qq: qqCommand,
  video: videoCommand,
  health: healthCommand,
  gallery: galleryCommand,
}
const historyStatuses = new Set(['waiting', 'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted', 'completed'])

function formatHelpLines(entries) {
  const lines = []
  for (const [cmd, spec] of entries) {
    lines.push(`${cmd} ${spec.usage ?? ''}`.trimEnd() + `\n    ${spec.about}`)
    if (spec.subcommands) {
      for (const [sub, subSpec] of Object.entries(spec.subcommands)) {
        lines.push(`  ${cmd} ${sub} ${subSpec.usage ?? ''}`.trimEnd() + `\n      ${subSpec.about}`)
      }
    }
  }
  return lines
}

function help(topics, json) {
  const [name, sub] = Array.isArray(topics) ? topics : topics ? [topics] : []
  if (name && !Object.hasOwn(commands, name)) throw new Error(`未知命令：${name}`)
  const skill = fileURLToPath(new URL('./SKILL.md', import.meta.url))
  let selected
  if (sub !== undefined) {
    const group = commands[name]
    if (!group?.subcommands || !Object.hasOwn(group.subcommands, sub)) {
      throw new Error(`未知子命令：${name} ${sub}`)
    }
    selected = [[`${name} ${sub}`, group.subcommands[sub]]]
  } else {
    selected = name ? [[name, commands[name]]] : Object.entries(commands)
  }
  if (json) return { name: 'cli-anything-huiyu', skill, commands: Object.fromEntries(selected) }
  return ['cli-anything-huiyu [--json] [--compact] <命令> [参数]', ...formatHelpLines(selected),
    '本机默认端口 3211；HUIYU_CLI_URL 可指定 Tailscale HTTP 或 Muse 中转 HTTPS 地址。直连使用 HUIYU_CLI_TOKEN，中转使用 MUSE_TOKEN。',
    '直接运行进入交互模式。输入 help 查看命令，@last 表示最近提交的批次，exit 退出。', `助手说明：${skill}`,
  ].join('\n')
}

function itemIndex(value = '1') {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('--item 需要从 1 开始的整数。')
  return Number(value)
}

function query(path, options) {
  const params = new URLSearchParams(options)
  return api('GET', params.size ? `${path}?${params}` : path)
}

function inferUploadFamily(options, input) {
  const kind = options.kind ?? input?.kind
  const model = (options.model ?? input?.modelId ?? '').toLowerCase()
  if (kind === 'manga' || model === 'manga-screen') return 'manga'
  if (model.startsWith('qwen')) return 'qwen'
  if (model.startsWith('flux-kontext') || model.startsWith('minimax-h3')) return 'keyframe'
  if (model.startsWith('moss')) return 'moss'
  if (model.startsWith('krea2')) return 'krea2'
  return 'anima'
}

async function resolveImageHandle(value, family) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('图片参数不能为空。')
  const trimmed = value.trim()
  if (UPLOADED_IMAGE_HANDLE.test(trimmed)) return trimmed
  return (await uploadImage(trimmed, { family })).name
}

function drawingOverrides(options) {
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

async function resolveControlOverrides(options, input, overrides, batch) {
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

function buildFromInterrogate(data, modelId) {
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

function promptOptions(options) {
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

function finiteNumber(raw, label) {
  const value = Number(raw)
  if (!raw.trim() || !Number.isFinite(value)) throw new Error(`${label} 需要有限数值。`)
  return value
}

function positiveInteger(raw, label) {
  const value = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} 需要正整数。`)
  return value
}

function waitTimeout(raw) {
  if (raw === undefined) return undefined
  const value = positiveInteger(raw, '--timeout')
  if (value > 2_147_483) throw new Error('--timeout 最多为 2147483 秒。')
  return value
}

async function drawingInput(options, args, batch) {
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

async function drawOrBatch(options, args, session, batch) {
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

async function saveOneResult(receipt, output, options) {
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

async function recentJobs({ agent, status: filterStatus, ...page }) {
  if (agent !== undefined) agentName(agent)
  if (filterStatus !== undefined && !historyStatuses.has(filterStatus)) throw new Error('--status 需要有效的任务状态。')
  if (agent === undefined && filterStatus === undefined) return query('/api/muse/jobs', page)
  const filters = { ...page }
  if (agent !== undefined) filters.agent = agent
  if (filterStatus !== undefined) filters.status = filterStatus
  let result
  try { result = await query('/api/muse/jobs', filters) }
  catch (error) {
    if (![400, 422].includes(error.httpStatus)) throw error
    result = await query('/api/muse/jobs', page)
  }
  if (!Array.isArray(result.items)) throw new Error('历史回执缺少任务清单。')
  const items = result.items.filter(item => (agent === undefined || item.batchKey?.startsWith(`${agent}_`))
    && (filterStatus === undefined || item.status === filterStatus))
  return { ...result, items, batches: items.filter(item => item.entryType === 'batch') }
}

async function run(name, options, args, session, subcommand) {
  switch (name) {
    case 'status': return status()
    case 'guide': return guide()
    case 'models': return models({ modelId: options.model, character: options.character })
    case 'doctor': return doctor()
    case 'key': return { requestKey: newRequestKey() }
    case 'upload': return runUpload(options, args)
    case 'interrogate': return runInterrogate(options, args)
    case 'upscale': return runUpscale(options, args, session)
    case 'voice': return runVoice(subcommand, options, args)
    case 'desktop': return runDesktop(subcommand, options, args)
    case 'qq': return runQq(subcommand, options, args)
    case 'video': return runVideo(subcommand, options, args)
    case 'health': return runHealth()
    case 'gallery': return runGallery(subcommand, options, args)
    case 'catalog': {
      if (options['page-size'] !== undefined) {
        options.pageSize = options['page-size']
        delete options['page-size']
      }
      return query('/api/muse/catalog', options)
    }
    case 'detail': {
      const [kind, id] = args
      const parts = id.split('/')
      if (!['character', 'outfit', 'scene', 'blueprint'].includes(kind) || parts.some(part => !part || part === '.' || part === '..')) {
        throw new Error('请使用目录返回的类型和完整 ID。')
      }
      return api('GET', `/api/muse/catalog/${kind}/${parts.map(encodeURIComponent).join('/')}`)
    }
    case 'draw':
    case 'batch': return drawOrBatch(options, args, session, name === 'batch')
    case 'queue': return api('GET', '/api/muse/queue')
    case 'recent': return recentJobs(options)
    case 'errors': {
      if (args.length) {
        if (Object.keys(options).length) throw new Error('按批次查询时只需批次编号。历史筛选参数适用于不带编号的查询。')
        break
      }
      const { agent, ...page } = options
      if (agent !== undefined) agentName(agent)
      return errorsFrom(await query('/api/muse/jobs', page), { agent })
    }
  }
  const key = requestKey(args[0] === '@last' ? session.last : args[0])
  const path = `/api/muse/batches/${key}`
  try {
    if (name === 'wait') {
      const interval = options.interval === undefined ? undefined : positiveInteger(options.interval, '--interval')
      if (interval !== undefined && interval < 2) throw new Error('--interval 至少为 2 秒。')
      return await waitForBatch(key, {
        item: options.item === undefined ? undefined : itemIndex(options.item),
        timeout: waitTimeout(options.timeout), interval,
      })
    }
    if (name === 'save' && options.all && options.item !== undefined) throw new Error('--all 和 --item 请只选一个。')
    return await batchCommand(name, path, key, options, args)
  } catch (error) {
    error.requestKey = key
    throw error
  }
}

// Structured callers provide data only. File flags, shell strings and output paths
// belong to interactive CLI users, never to model-generated input.
async function invoke() {
  const input = JSON.parse(await readStdin(12 * 1024 * 1024, '工具请求'))
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(k => !['action', 'batchKey', 'item', 'params'].includes(k))) throw new Error('工具请求格式无效。')
  const { action, batchKey, item, params = {} } = input
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('params 须为 JSON 对象。')
  if (!tool.function.parameters.properties.action.enum.includes(action)) throw new Error('请选择有效的绘图操作。')
  try {
    const scoped = process.env.HUIYU_CLI_SCOPE
    if (scoped && (!SCOPED_ALLOWED_ACTIONS.has(action)
        || (action === 'errors' && batchKey === undefined)
        || (batchKey !== undefined && !requestKey(batchKey).startsWith(agentName(scoped) + '_')))) {
      throw Object.assign(new Error('群聊只可操作本群当前发起人名下的共享批次；全机状态、作品册、音视频和原图归档仅在机主私聊可用。'), { code: 'DRAWING_SCOPE_DENIED' })
    }
    if (batchKey !== undefined && !BATCH_KEY_ACTIONS.has(action)) throw new Error('该操作不接受 batchKey。')
    if (item !== undefined && (!['save', 'cancel'].includes(action) || !Number.isSafeInteger(item) || item < 1)) throw new Error('item 仅用于取图或取消，序号从 1 开始。')
    if (action === 'draw' || action === 'batch') return await submit(params, requestKey(batchKey), action === 'batch')
    if (action === 'upscale') return await submitUpscale(params, requestKey(batchKey))
    if (action === 'health') return await runHealth()
    if (action === 'interrogate_status') return await interrogateStatus()
    if (action === 'interrogate') {
      return await interrogateJson(batchKey !== undefined ? { ...params, requestKey: requestKey(batchKey) } : params)
    }
    if (action === 'voice_status') return await voiceStatus()
    if (action === 'voice_say') {
      const { receipt } = await voiceSynthesize(params, batchKey)
      return { ...receipt, verified: true }
    }
    if (action === 'video_status') {
      if (params.modelId !== undefined && typeof params.modelId !== 'string') throw new Error('video_status 只接受字符串 modelId。')
      return await videoStatus({ model: params.modelId })
    }
    if (action === 'video_preview') return await api('POST', '/api/muse/video/prompt/preview', params)
    if (action === 'video_create') {
      const key = requestKey(batchKey ?? params.requestKey ?? newRequestKey())
      return await api('POST', '/api/muse/video/jobs', { ...params, requestKey: key })
    }
    if (action === 'video_batch') {
      const key = requestKey(batchKey ?? params.requestKey ?? newRequestKey())
      return await api('POST', '/api/muse/video/batches', { ...params, requestKey: key })
    }
    if (action === 'video_job') {
      const id = batchKey ?? params.id
      if (typeof id !== 'string') throw new Error('video_job 需要 batchKey 或 params.id。')
      return await videoJob(id, { byRequest: Boolean(params.byRequest), batch: Boolean(params.batch) })
    }
    if (action === 'video_cancel') {
      const id = batchKey ?? params.id
      if (typeof id !== 'string') throw new Error('video_cancel 需要 batchKey 或 params.id。')
      return await videoCancel(id, { byRequest: Boolean(params.byRequest), batch: Boolean(params.batch) })
    }
    if (action === 'video_concat') {
      const id = batchKey ?? params.id
      if (typeof id !== 'string') throw new Error('video_concat 需要 batchKey 或 params.id。')
      return await videoConcat(id, { byRequest: Boolean(params.byRequest) })
    }
    if (action === 'gallery_list') {
      const queryOpts = {}
      const mapping = { page: 'page', pageSize: 'page-size', kind: 'kind', character: 'character',
        search: 'search', favorite: 'favorite', tag: 'tag', engine: 'engine', model: 'model', reviewState: 'review-state' }
      for (const [key, value] of Object.entries(params)) {
        const mapped = mapping[key]
        if (!mapped || !(typeof value === 'string' || typeof value === 'boolean' || Number.isSafeInteger(value))) {
          throw new Error('无效的作品册查询参数：' + key)
        }
        queryOpts[mapped] = String(value)
      }
      queryOpts['page-size'] ??= '10'
      return await galleryList(queryOpts)
    }
    if (action === 'gallery_show') {
      const isNumberId = Number.isSafeInteger(params.id)
      if ((!isNumberId && typeof params.id !== 'string') || (params.idType !== undefined && typeof params.idType !== 'string')) {
        throw new Error('gallery_show 需要字符串或整数 params.id（可选 params.idType）。')
      }
      return await galleryShow(String(params.id), { idType: params.idType ?? (isNumberId ? 'number' : undefined) })
    }
    let args = []
    const options = {}
    if (action === 'detail') {
      if (Object.keys(params).some(k => !['kind', 'id'].includes(k)) || typeof params.id !== 'string'
          || typeof params.kind !== 'string') throw new Error('detail 需要 params.kind 和 params.id。')
      args = [params.kind, params.id]
    } else if (action === 'models') {
      if (Object.entries(params).some(([key, value]) => !['modelId', 'character'].includes(key) || typeof value !== 'string')) {
        throw new Error('models 只接受可选的 modelId 和 character 文本。')
      }
      return await models(params)
    } else {
      const allowed = commands[action].options ?? []
      for (const [key, value] of Object.entries(params)) {
        const option = key === 'pageSize' ? 'page-size' : key
        if (!['catalog', 'recent', 'errors'].includes(action) || !allowed.includes(option)
            || !(typeof value === 'string' || Number.isSafeInteger(value))) throw new Error('无效的查询参数：' + key)
        options[option] = String(value)
      }
    }
    if (['job', 'cancel', 'save'].includes(action) || batchKey !== undefined) args = [requestKey(batchKey)]
    if (action === 'catalog') options['page-size'] ??= '5'
    if (action === 'recent' || (action === 'errors' && batchKey === undefined)) options.limit ??= '10'
    if (item !== undefined) options.item = String(item)
    if (action === 'save') {
      const directory = process.env.HUIYU_CLI_OUTPUT_DIR || process.cwd()
      args.push(join(directory, `huiyu-${args[0]}-${item ?? 1}.png`))
    }
    return await run(action, options, args, {})
  } catch (error) {
    throw Object.assign(error, { command: action })
  }
}

// Keep tool results valid JSON inside the smallest chat channel's 14,000-character limit.
// Ordinary CLI commands still return the full receipt.
function chatReceipt(receipt) {
  if (JSON.stringify(receipt).length <= 13_000) return receipt
  const summary = { ...receipt }
  if (Array.isArray(summary.items)) {
    delete summary.job
    delete summary.batches
    const rows = summary.items
    summary.items = []
    if (JSON.stringify(summary).length < 11_000) {
      let length = JSON.stringify(summary).length
      for (const row of rows) {
        length += JSON.stringify(row).length + 1
        if (length > 12_500) break
        summary.items.push(row)
      }
      if (summary.items.length !== rows.length) {
        summary.totalItemsInResponse = rows.length
        summary.truncated = true
        summary.hint = '需要完整明细时，用较小的 pageSize 或 limit 重查本页，或用命令行直接读取完整回执。'
      }
      return summary
    }
  }
  return { ok: receipt.ok ?? true, batchKey: receipt.batchKey, truncated: true,
    message: '回执超过聊天可显示的长度，请用相同的只读命令读取完整回执。' }
}

async function batchCommand(name, path, key, options, args) {
  const receipt = await readBatch(key)
  if (name === 'job') return receipt
  if (name === 'errors') return errorsFrom(receipt, { batchKey: key })
  const index = itemIndex(options.item)
  if (name === 'save') {
    const saveOptions = { singleConnection: options['single-connection'] }
    return options.all ? saveAll(receipt, args[1], saveOptions) : saveOriginal(receipt, index, args[1], saveOptions)
  }
  const target = options.item ? receipt.items?.[index - 1] : receipt
  if (!target) throw new Error('请用 job 核对批次中的序号。')
  const cancelPath = options.item ? `${path}/${requestKey(target.requestKey)}` : path
  // Single draws created by older desktops use a per-model cancellation receipt.
  if (target.cancelPath !== cancelPath && !['anima', 'moss', 'creative', 'qwen', 'keyframe', 'manga'].some(family => target.cancelPath === `/api/${family}/requests/${key}`)) {
    throw new Error('绘遇返回的取消地址与任务不符。')
  }
  return api('DELETE', target.cancelPath)
}

function compactReceipt(receipt) {
  if (!Array.isArray(receipt?.items)) return receipt
  const result = { ...receipt }
  if (result.items.length === 1 && result.batchKey) delete result.job
  if (Array.isArray(result.batches)) delete result.batches
  return result
}

function display(result, json) {
  if (json) return log(JSON.stringify(result))
  if (typeof result === 'string') return log(result)
  if (result.mode === 'relay' && result.storage) {
    const mib = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })
    const format = bytes => mib.format(bytes / 1024 ** 2)
    log(`中转暂存已用 ${format(result.storage.usedBytes)} MiB / ${format(result.storage.maxBytes)} MiB`)
  }
  if (result.scope === 'batch' || result.scope === 'historyPage') {
    const { items, ...summary } = result
    log(inspect(summary, { colors: process.stdout.isTTY }))
    return items.length ? table(items) : log('这些回执当前没有记录错误。')
  }
  if (Array.isArray(result.items)) {
    const { items, job: _job, batches: _batches, ...summary } = result
    log(inspect(summary, { depth: 3, colors: process.stdout.isTTY }))
    if (!items.length) return log('暂无条目。')
    return table(items.map((item, i) => ({
      '#': i + 1,
      ID: item.id || item.jobId || item.requestKey || item.eventId,
      名称: item.displayTitle || item.title || item.modelId || item.senderNickname || item.character || item.conversationId,
      状态: item.error || item.status || item.kind || (typeof item.text === 'string' ? item.text.slice(0, 60) : undefined),
      进度: item.progressText ?? item.progress,
    })))
  }
  log(inspect(result, { depth: null, colors: process.stdout.isTTY }))
}

async function execute(argv, session, json, compact) {
  const args = [...argv]
  while (['--json', '--compact'].includes(args[0])) {
    if (args.shift() === '--json') json = true
    else compact = true
  }
  const name = args.shift()
  if (!name || ['help', '--help', '-h'].includes(name)) {
    const topics = args.filter(arg => !['--json', '--compact'].includes(arg))
    if (topics.length > 2) throw new Error('用法：help [命令] [子命令]')
    json ||= args.includes('--json')
    display(help(topics, json), json)
    return
  }
  if (!Object.hasOwn(commands, name)) throw new Error(`未知命令：${name}。输入 help 查看用法。`)
  const rootSpec = commands[name]
  let spec = rootSpec
  let sub
  if (rootSpec.subcommands) {
    while (['--json', '--compact'].includes(args[0])) {
      if (args.shift() === '--json') json = true
      else compact = true
    }
    const candidate = args.shift()
    if (!candidate || ['help', '--help', '-h'].includes(candidate)) {
      json ||= args.includes('--json')
      display(help([name], json), json)
      return
    }
    if (!Object.hasOwn(rootSpec.subcommands, candidate)) {
      throw new Error(`未知 ${name} 子命令：${candidate}。输入 help ${name} 查看用法。`)
    }
    sub = candidate
    spec = rootSpec.subcommands[sub]
  }
  const booleans = new Set(spec.booleans ?? [])
  const multiples = new Set(spec.multiple ?? [])
  const options = Object.fromEntries((spec.options ?? []).map(key => [key, {
    type: booleans.has(key) ? 'boolean' : 'string', multiple: multiples.has(key),
  }]))
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    ...options, json: { type: 'boolean' }, compact: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } })
  json ||= values.json
  compact ||= values.compact
  if (values.help) return display(help(sub ? [name, sub] : [name], json), json)
  const max = spec.args ?? 0
  const label = sub ? `${name} ${sub}` : name
  if (positionals.length < (spec.minArgs ?? max) || positionals.length > max) throw new Error(`用法：${label} ${spec.usage ?? ''}`)
  delete values.json
  delete values.compact
  delete values.help
  const receipt = name === 'invoke' ? await invoke() : await run(name, values, positionals, session, sub)
  const result = compact ? compactReceipt(receipt) : receipt
  const outputReceipt = values.out !== undefined || values['out-dir'] !== undefined || values['out-json'] !== undefined
    || Boolean(values.all) || result.timedOut === true
    || (sub === 'save' && ['video', 'gallery'].includes(name))
  display(name === 'invoke' ? chatReceipt(result) : result, json || outputReceipt)
}

// Quotes group spaces in prompts and filenames. Backslashes stay literal for Windows paths.
function words(line) {
  const args = []
  let value = '', quote = '', started = false
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = ''
      else value += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) args.push(value)
      value = ''
      started = false
    } else {
      value += char
      started = true
    }
  }
  if (quote) throw new Error('请补全引号。')
  if (started) args.push(value)
  return args
}

function commandNameFromArgs(args) {
  const tokens = args.filter(arg => !['--json', '--compact'].includes(arg))
  const [name, sub] = tokens
  if (!name || !Object.hasOwn(commands, name)) return undefined
  if (sub && commands[name].subcommands && Object.hasOwn(commands[name].subcommands, sub)) return `${name} ${sub}`
  return name
}

function report(error, args, session, json) {
  const command = commandNameFromArgs(args)
  const issue = failure(error, error.command ?? command)
  if (issue.requestKey && ['draw', 'batch', 'upscale'].includes(command)) session.last = issue.requestKey
  console.error(json || args.includes('--json') ? JSON.stringify(issue)
    : [`[${issue.code}] ${issue.message}`, issue.requestKey && `请求编号：${issue.requestKey}`, issue.hint].filter(Boolean).join('\n'))
}

const argv = process.argv.slice(2)
const session = {}
if (process.stdin.isTTY && argv.every(arg => ['--json', '--compact'].includes(arg))) {
  const rl = createInterface({ input: process.stdin, output: process.stderr, prompt: 'huiyu> ' })
  console.error('绘遇命令行 · help 查看命令，exit 退出')
  rl.prompt()
  for await (const line of rl) {
    if (['exit', 'quit'].includes(line.trim())) break
    let args = []
    try {
      args = words(line)
      if (args.length) await execute(args, session, argv.includes('--json'), argv.includes('--compact'))
    } catch (error) { report(error, args, session, argv.includes('--json')) }
    rl.prompt()
  }
  rl.close()
} else {
  try { await execute(argv, session, false) }
  catch (error) { report(error, argv, session, false); process.exitCode = 1 }
}

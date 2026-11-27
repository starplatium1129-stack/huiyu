#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { api, agentName, newRequestKey, readStdin, requestKey, submit } from './muse.mjs'
import { doctor, errorsFrom, guide, models, status } from './diagnostics.mjs'
import { saveAll, saveOriginal } from './download.mjs'
import { readBatch, waitForBatch } from './wait.mjs'
import { runVoice, voiceCommand, voiceStatus, voiceSynthesize } from './voice.mjs'
import { desktopCommand, qqCommand, runDesktop, runQq } from './channels.mjs'
import { runUpload, uploadCommand } from './upload.mjs'
import { runVideo, videoCancel, videoCommand, videoConcat, videoJob, videoStatus } from './video.mjs'
import { galleryCommand, galleryList, galleryShow, healthCommand, runGallery, runHealth } from './gallery.mjs'
import { interrogateCommand, interrogateJson, interrogateStatus, runInterrogate, runUpscale, submitUpscale, upscaleCommand } from './interrogate.mjs'
import { drawOrBatch, drawingHelp, drawingOptions, positiveInteger, previewDrawing, promptTextOptions, waitTimeout } from './drawing.mjs'
import { chatReceipt, compactReceipt, display, help, report, words } from './format.mjs'
import tool from './tool.json' with { type: 'json' }

const SCOPED_ALLOWED_ACTIONS = new Set(['status', 'key', 'catalog', 'detail', 'models', 'draw', 'draw_preview', 'batch', 'upscale', 'job', 'errors', 'cancel'])
const BATCH_KEY_ACTIONS = new Set([
  'job', 'errors', 'cancel', 'save', 'draw', 'batch', 'upscale',
  'interrogate', 'voice_say', 'video_create', 'video_job', 'video_cancel', 'video_batch', 'video_concat',
])

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
    usage: '(--id 目录ID | --outfit 服装ID | --cast 角色[:服装][:动作] | --cast-file JSON | --prompt 文本或- | --file JSON或- | --from-interrogate 反推JSON | --layout-file 布局JSON | --init-image 底图) [出图选项] [--dry-run | [--key 编号] [--wait] [--timeout 秒] [--out PNG]]',
    about: `提交单图或变体。--dry-run 只返回编译配方，图片参数使用已上传文件名。--id 可配合 --outfit 换装或配合 --cast 做多角色同框，--kind 指定 scene、blueprint、outfit、prompt 或 manga；Krea 2 目录配方支持 --style-lora；--from-interrogate 读取反推标签、描述和布局，搭配 --cast 时会过滤原人物特征。--out 等待并保存一张原图。\n    自定义提示词可用 --negative、--steps、--cfg、--character、--lora、--lora-strength；漫画网点（manga-screen）可用 --operation、--pen-lines、--pen-lines-polarity、--pen-lines-fit。保存时可用 --single-connection。\n    ${drawingHelp}`,
    options: ['id', 'outfit', 'kind', 'prompt', 'file', 'from-interrogate', 'dry-run', 'key', 'wait', 'timeout', 'out', 'single-connection', ...drawingOptions,
      ...Object.keys(promptTextOptions), 'steps', 'cfg', 'lora-strength', 'pen-lines'],
    booleans: ['dry-run', 'wait', 'single-connection'],
    multiple: ['ref', 'cast', 'interaction'],
  },
  batch: {
    usage: '(批量.json | - | --ids ID1,ID2) [出图选项] [--key 编号] [--wait] [--timeout 秒] [--out-dir 目录]', args: 1, minArgs: 0,
    about: `批次含变体最多 16 张。可重复传 --ids，也可用 - 从标准输入读 JSON。各项自己的设置优先于整批默认值。保存时可用 --single-connection。\n    ${drawingHelp}`,
    options: ['ids', 'key', 'wait', 'timeout', 'out-dir', 'single-connection', ...drawingOptions],
    booleans: ['wait', 'single-connection'],
    multiple: ['ids', 'ref', 'cast', 'interaction'],
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

function itemIndex(value = '1') {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('--item 需要从 1 开始的整数。')
  return Number(value)
}

function query(path, options) {
  const params = new URLSearchParams(options)
  return api('GET', params.size ? `${path}?${params}` : path)
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
    if (params.dryRun !== undefined && typeof params.dryRun !== 'boolean') throw new Error('dryRun 须为布尔值。')
    if (action === 'draw_preview' || params.dryRun === true) {
      if (!['draw', 'draw_preview'].includes(action) || batchKey !== undefined) throw new Error('单图预览请用 draw_preview，省略 batchKey。')
      return await previewDrawing(params)
    }
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
    display(help(commands, topics, json), json)
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
      display(help(commands, [name], json), json)
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
  // node:util considers a separate negative value another flag.
  for (let index = 0; index + 1 < args.length; index++) {
    if (args[index] === '--style-lora-strength' && /^-(?:\d+(?:\.\d*)?|\.\d+)$/.test(args[index + 1])) {
      args.splice(index, 2, `--style-lora-strength=${args[index + 1]}`)
    }
  }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    ...options, json: { type: 'boolean' }, compact: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } })
  json ||= values.json
  compact ||= values.compact
  if (values.help) return display(help(commands, sub ? [name, sub] : [name], json), json)
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
    } catch (error) { report(commands, error, args, session, argv.includes('--json')) }
    rl.prompt()
  }
  rl.close()
} else {
  try { await execute(argv, session, false) }
  catch (error) { report(commands, error, argv, session, false); process.exitCode = 1 }
}

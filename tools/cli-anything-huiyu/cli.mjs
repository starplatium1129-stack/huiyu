#!/usr/bin/env node
import { log, table } from 'node:console'
import { createInterface } from 'node:readline/promises'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect, parseArgs } from 'node:util'
import { api, agentName, newRequestKey, readInput, requestKey, saveOriginal, submit } from './muse.mjs'
import { errorsFrom, failure, status } from './diagnostics.mjs'
import tool from './tool.json' with { type: 'json' }

const commands = {
  invoke: { about: '从标准输入读取 huiyu_drawing 工具参数 JSON。用 --json help invoke 读取工具定义。', tool },
  status: { about: '检查配置的出图机连接。HTTPS 中转会分别返回中转可达性和出图机在线状态。' },
  key: { about: '生成可跨助手传递的请求编号，提交与重试使用同一个编号。HUIYU_CLI_AGENT 可设置助手名前缀。' },
  catalog: {
    usage: '[--kind 类型] [--search 关键词] [--character 角色] [--category 分类] [--rating 分级] [--page 页码] [--page-size 条数]',
    about: '搜索角色、服装、场景和蓝图。kind 可用 media、scene、blueprint、character、outfit。',
    options: ['kind', 'search', 'character', 'category', 'rating', 'page', 'page-size'],
  },
  detail: { usage: '类型 ID', args: 2, about: '读取角色、服装或场景配方详情，保留 ID 中的斜杠。' },
  draw: {
    usage: '(--id 目录ID | --prompt 提示词 | --file 单图.json) [--key 请求编号]',
    about: '提交单图。JSON 文件可指定模型、种子、尺寸、换装和变体。', options: ['id', 'prompt', 'file', 'key'],
  },
  batch: { usage: '批量.json [--key 请求编号]', args: 1, about: '提交含 ids 或 items 的批次，含变体最多 16 张。', options: ['key'] },
  queue: { about: '查看当前队列与进度。' },
  recent: { usage: '[--since 起点] [--before 游标] [--limit 条数]', about: '查看近期任务，用 nextBefore 翻页。', options: ['since', 'before', 'limit'] },
  errors: { usage: '[批次编号 | --agent 助手名] [--since 起点] [--before 游标] [--limit 条数]', minArgs: 0, args: 1,
    about: '按批次查每张图的生成和交付错误，或筛选一页历史记录。历史结果用 nextBefore 翻页。', options: ['agent', 'since', 'before', 'limit'] },
  job: { usage: '批次编号', args: 1, about: '按提交回执的 batchKey 查看每一张的状态。' },
  cancel: { usage: '批次编号 [--item 序号]', args: 1, about: '取消整批或指定的单张，序号从 1 开始。', options: ['item'] },
  save: { usage: '批次编号 目标.png [--item 序号]', args: 2, about: '校验并保存原图。默认取第一张。', options: ['item'] },
}

function help(name, json) {
  if (name && !Object.hasOwn(commands, name)) throw new Error(`未知命令：${name}`)
  const selected = name ? [[name, commands[name]]] : Object.entries(commands)
  const skill = fileURLToPath(new URL('./SKILL.md', import.meta.url))
  if (json) return { name: 'cli-anything-huiyu', skill, commands: Object.fromEntries(selected) }
  const lines = selected.map(([cmd, spec]) => `${cmd} ${spec.usage ?? ''}\n    ${spec.about}`)
  return ['cli-anything-huiyu [--json] <命令> [参数]', ...lines,
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

async function run(name, options, args, session) {
  switch (name) {
    case 'status': return status()
    case 'key': return { requestKey: newRequestKey() }
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
    case 'draw': {
      if (['id', 'prompt', 'file'].filter(key => options[key] !== undefined).length !== 1) {
        throw new Error('请指定 --id、--prompt 或 --file 中的一项。')
      }
      let input
      if (options.file !== undefined) input = await readInput(options.file, false)
      else if (options.id !== undefined) input = { id: options.id }
      else input = { prompt: options.prompt }
      return submit(input, options.key, false)
    }
    case 'batch': return submit(await readInput(args[0], true), options.key, true)
    case 'queue': return api('GET', '/api/muse/queue')
    case 'recent': return query('/api/muse/jobs', options)
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
    return await batchCommand(name, path, key, options, args)
  } catch (error) {
    error.requestKey = key
    throw error
  }
}

// Structured callers provide data only. File flags, shell strings and output paths
// belong to interactive CLI users, never to model-generated input.
async function invoke() {
  const chunks = []
  let length = 0
  for await (const chunk of process.stdin) {
    length += chunk.length
    if (length > 256 * 1024) throw new Error('工具请求超过 256 KiB。')
    chunks.push(chunk)
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(k => !['action', 'batchKey', 'item', 'params'].includes(k))) throw new Error('工具请求格式无效。')
  const { action, batchKey, item, params = {} } = input
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('params 须为 JSON 对象。')
  if (typeof action !== 'string' || !Object.hasOwn(commands, action) || action === 'invoke') throw new Error('请选择有效的绘图操作。')
  try {
    const scoped = process.env.HUIYU_CLI_SCOPE
    if (scoped && (['queue', 'recent', 'save'].includes(action) || (action === 'errors' && batchKey === undefined)
        || (batchKey !== undefined && !requestKey(batchKey).startsWith(agentName(scoped) + '_')))) {
      throw Object.assign(new Error('群聊只可操作本群当前发起人名下的共享批次；全机记录和原图归档可在机主私聊查看。'), { code: 'DRAWING_SCOPE_DENIED' })
    }
    if (batchKey !== undefined && !['job', 'errors', 'cancel', 'save', 'draw', 'batch'].includes(action)) throw new Error('该操作不接受 batchKey。')
    if (item !== undefined && (!['save', 'cancel'].includes(action) || !Number.isSafeInteger(item) || item < 1)) throw new Error('item 仅用于取图或取消，序号从 1 开始。')
    if (action === 'draw' || action === 'batch') return await submit(params, requestKey(batchKey), action === 'batch')
    let args = []
    const options = {}
    if (action === 'detail') {
      if (Object.keys(params).some(k => !['kind', 'id'].includes(k)) || typeof params.id !== 'string') throw new Error('detail 需要 params.kind 和 params.id。')
      args = [params.kind, params.id]
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
      await mkdir(directory, { recursive: true })
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
  const receipt = await api('GET', path)
  if (receipt.batchKey !== key) throw new Error('任务回执与查询编号不符。')
  if (name === 'job') return receipt
  if (name === 'errors') return errorsFrom(receipt, { batchKey: key })
  const index = itemIndex(options.item)
  if (name === 'save') return saveOriginal(receipt, index, args[1])
  const target = options.item ? receipt.items?.[index - 1] : receipt
  if (!target) throw new Error('请用 job 核对批次中的序号。')
  const cancelPath = options.item ? `${path}/${requestKey(target.requestKey)}` : path
  // Single draws created by older desktops use a per-model cancellation receipt.
  if (target.cancelPath !== cancelPath && !['anima', 'moss'].some(family => target.cancelPath === `/api/${family}/requests/${key}`)) {
    throw new Error('绘遇返回的取消地址与任务不符。')
  }
  return api('DELETE', target.cancelPath)
}

function display(result, json) {
  if (json) return log(JSON.stringify(result))
  if (typeof result === 'string') return log(result)
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
      '#': i + 1, ID: item.id || item.jobId || item.requestKey, 名称: item.displayTitle || item.title || item.modelId,
      状态: item.error || item.status || item.kind, 进度: item.progressText ?? item.progress,
    })))
  }
  log(inspect(result, { depth: null, colors: process.stdout.isTTY }))
}

async function execute(argv, session, json) {
  const args = [...argv]
  if (args[0] === '--json') { json = true; args.shift() }
  const name = args.shift()
  if (!name || ['help', '--help', '-h'].includes(name)) {
    const topics = args.filter(arg => arg !== '--json')
    if (topics.length > 1) throw new Error('用法：help [命令]')
    json ||= args.includes('--json')
    display(help(topics[0], json), json)
    return
  }
  if (!Object.hasOwn(commands, name)) throw new Error(`未知命令：${name}。输入 help 查看用法。`)
  const spec = commands[name]
  const options = Object.fromEntries((spec.options ?? []).map(key => [key, { type: 'string' }]))
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    ...options, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } })
  json ||= values.json
  if (values.help) return display(help(name, json), json)
  const max = spec.args ?? 0
  if (positionals.length < (spec.minArgs ?? max) || positionals.length > max) throw new Error(`用法：${name} ${spec.usage ?? ''}`)
  delete values.json
  delete values.help
  const result = name === 'invoke' ? chatReceipt(await invoke()) : await run(name, values, positionals, session)
  if (name === 'draw' || name === 'batch') session.last = result.batchKey
  display(result, json)
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

function report(error, args, session, json) {
  const name = args[0] === '--json' ? args[1] : args[0]
  const issue = failure(error, error.command ?? (Object.hasOwn(commands, name) ? name : undefined))
  if (issue.requestKey && ['draw', 'batch'].includes(name)) session.last = issue.requestKey
  console.error(json || args.includes('--json') ? JSON.stringify(issue)
    : [`[${issue.code}] ${issue.message}`, issue.requestKey && `请求编号：${issue.requestKey}`, issue.hint].filter(Boolean).join('\n'))
}

const argv = process.argv.slice(2)
const session = {}
if (process.stdin.isTTY && (argv.length === 0 || (argv.length === 1 && argv[0] === '--json'))) {
  const rl = createInterface({ input: process.stdin, output: process.stderr, prompt: 'huiyu> ' })
  console.error('绘遇命令行 · help 查看命令，exit 退出')
  rl.prompt()
  for await (const line of rl) {
    if (['exit', 'quit'].includes(line.trim())) break
    let args = []
    try {
      args = words(line)
      if (args.length) await execute(args, session, argv.includes('--json'))
    } catch (error) { report(error, args, session, argv.includes('--json')) }
    rl.prompt()
  }
  rl.close()
} else {
  try { await execute(argv, session, false) }
  catch (error) { report(error, argv, session, false); process.exitCode = 1 }
}

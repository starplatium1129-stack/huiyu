import { log, table } from 'node:console'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import { failure } from './diagnostics.mjs'

export function formatHelpLines(entries) {
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

export function help(commands, topics, json) {
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

// Keep tool results valid JSON inside the smallest chat channel's 14,000-character limit.
// Ordinary CLI commands still return the full receipt.
export function chatReceipt(receipt) {
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

export function compactReceipt(receipt) {
  if (!Array.isArray(receipt?.items)) return receipt
  const result = { ...receipt }
  if (result.items.length === 1 && result.batchKey) delete result.job
  if (Array.isArray(result.batches)) delete result.batches
  return result
}

export function display(result, json) {
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

// Quotes group spaces in prompts and filenames. Backslashes stay literal for Windows paths.
export function words(line) {
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

export function commandNameFromArgs(commands, args) {
  const tokens = args.filter(arg => !['--json', '--compact'].includes(arg))
  const [name, sub] = tokens
  if (!name || !Object.hasOwn(commands, name)) return undefined
  if (sub && commands[name].subcommands && Object.hasOwn(commands[name].subcommands, sub)) return `${name} ${sub}`
  return name
}

export function report(commands, error, args, session, json) {
  const command = commandNameFromArgs(commands, args)
  const issue = failure(error, error.command ?? command)
  if (issue.requestKey && ['draw', 'batch', 'upscale'].includes(command)) session.last = issue.requestKey
  console.error(json || args.includes('--json') ? JSON.stringify(issue)
    : [`[${issue.code}] ${issue.message}`, issue.requestKey && `请求编号：${issue.requestKey}`, issue.hint].filter(Boolean).join('\n'))
}

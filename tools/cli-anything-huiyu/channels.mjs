import { randomUUID } from 'node:crypto'
import { api, readFileBytes, readInput, readStdin, requestKey, uuidKey } from './muse.mjs'

const MAX_INBOX_WAIT = 30
const QQ_MEDIA_LIMIT = 3 * 1024 * 1024
const PNG_HEADER = Buffer.from('89504e470d0a1a0a', 'hex')
const FORBIDDEN_DRAWING_KEYS = new Set(['requestKey', 'action', 'preview'])

export const desktopCommand = {
  usage: '<inbox|reply> [参数]',
  about: '拉取桌面角色聊天收件箱并回传角色回复（可附带出图批次）。',
  subcommands: {
    inbox: {
      usage: '[--wait 秒]',
      about: '拉取待回复的桌面聊天消息。--wait 支持 0–30 秒长轮询。',
      options: ['wait'],
    },
    reply: {
      usage: '<requestKey> (<文字|-> | --file JSON或-) [--drawing-ids ID1,ID2] [--drawing-file JSON或-]',
      minArgs: 1,
      args: 2,
      about: '回复桌面聊天来信。可传文字（- 表示标准输入）或 --file 完整 JSON；可选 --drawing-ids 或 --drawing-file 附带出图批次。',
      options: ['file', 'drawing-ids', 'drawing-file'],
      multiple: ['drawing-ids'],
    },
  },
}

export const qqCommand = {
  usage: '<inbox|targets|context|reply|send|search> [参数]',
  about: '收发 QQ 群/私聊消息、查询会话上下文与公开网页搜索。',
  subcommands: {
    inbox: {
      usage: '[--wait 秒]',
      about: '拉取 QQ 待处理来信。--wait 支持 0–30 秒长轮询。',
      options: ['wait'],
    },
    targets: {
      about: '查看已授权给 Muse 的 QQ 会话列表及主动发言开关。',
    },
    context: {
      usage: '<conversationId>',
      args: 1,
      about: '读取指定 QQ 群最近 1 小时最多 64 条上下文消息。',
    },
    reply: {
      usage: '<requestKey> [--text 文字|-] [--image 图片] [--audio MP3] [--mention senderId] [--skip]',
      args: 1,
      about: '回复 QQ 来信。可附文字和/或单个附件（JPEG/PNG 或 MP3，均 ≤3 MiB），或传 --skip 跳过非 @ 群消息。',
      options: ['text', 'image', 'audio', 'mention', 'skip'],
      booleans: ['skip'],
    },
    send: {
      usage: '<conversationId> [--key UUID] [--text 文字|-] [--image 图片] [--audio MP3] [--mention senderId]',
      args: 1,
      about: '向已授权 QQ 会话主动发送文字、图片（JPEG/PNG ≤3 MiB）或语音（MP3 ≤3 MiB），三选一。',
      options: ['key', 'text', 'image', 'audio', 'mention'],
    },
    search: {
      usage: '<query> (--key 来信编号 | --conversation 会话ID [--key UUID])',
      args: 1,
      about: '通过绘遇联网检索公开网页。传 --key 关联来信，或传 --conversation 主动检索。',
      options: ['key', 'conversation'],
    },
  },
}

function inboxWaitSeconds(raw) {
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw)) throw new Error('--wait 需要 0–30 的整数秒。')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value > MAX_INBOX_WAIT) {
    throw new Error('--wait 需要 0–30 的整数秒。')
  }
  return value
}

function conversationId(raw) {
  if (typeof raw !== 'string' || !raw.trim() || [...raw].length > 256 || /[\p{Cc}\/\\]/u.test(raw)) {
    throw new Error('conversationId 格式无效。')
  }
  return raw.trim()
}

function checkPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}须为 JSON 对象。`)
  }
  return value
}

function checkDesktopDrawing(drawing) {
  checkPlainObject(drawing, 'drawing')
  const keys = Object.keys(drawing)
  if (!keys.length || keys.some(key => FORBIDDEN_DRAWING_KEYS.has(key))) {
    throw new Error('drawing 须为非空批次参数对象，且不能包含 requestKey、action 或 preview。')
  }
  return drawing
}

function isMp3Buffer(buffer) {
  let offset = 0
  while (offset + 3 <= buffer.length && buffer[offset] === 0x49 && buffer[offset + 1] === 0x44 && buffer[offset + 2] === 0x33) {
    if (offset + 10 > buffer.length) return false
    const major = buffer[offset + 3]
    if (major < 2 || major > 4) return false
    const s0 = buffer[offset + 6], s1 = buffer[offset + 7], s2 = buffer[offset + 8], s3 = buffer[offset + 9]
    if ((s0 | s1 | s2 | s3) & 0x80) return false
    const size = (s0 << 21) | (s1 << 14) | (s2 << 7) | s3
    const footer = major === 4 && (buffer[offset + 5] & 0x10) !== 0 ? 10 : 0
    offset += 10 + size + footer
    if (offset > buffer.length) return false
  }
  if (offset + 4 > buffer.length) return false
  const b0 = buffer[offset], b1 = buffer[offset + 1], b2 = buffer[offset + 2]
  return b0 === 0xff
    && (b1 & 0xe0) === 0xe0
    && ((b1 >> 3) & 3) !== 1
    && ((b1 >> 1) & 3) === 1
    && (b2 >> 4) !== 15
    && ((b2 >> 2) & 3) !== 3
}

function sniffQqImageMime(buffer) {
  if (buffer.length >= PNG_HEADER.length && buffer.subarray(0, PNG_HEADER.length).equals(PNG_HEADER)) {
    return 'image/png'
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  return null
}

async function encodeQqImage(file) {
  const data = await readFileBytes(file, QQ_MEDIA_LIMIT, 'QQ 图片')
  if (!data.length) throw new Error('QQ 图片文件为空。')
  const mimeType = sniffQqImageMime(data)
  if (!mimeType) throw new Error('QQ 图片仅支持 JPEG 或 PNG 格式，且不超过 3 MiB。')
  return { mimeType, data: data.toString('base64') }
}

async function encodeQqAudio(file) {
  const data = await readFileBytes(file, QQ_MEDIA_LIMIT, 'QQ 语音')
  if (!data.length) throw new Error('QQ 语音文件为空。')
  if (!isMp3Buffer(data)) throw new Error('QQ 语音仅支持 MP3 格式（audio/mpeg），且不超过 3 MiB。')
  return { mimeType: 'audio/mpeg', data: data.toString('base64') }
}

async function readTextOption(raw, label) {
  if (raw === undefined) return undefined
  return raw === '-' ? await readStdin(64 * 1024, label) : raw
}

export async function desktopInbox(options) {
  const wait = inboxWaitSeconds(options.wait)
  const path = wait === undefined ? '/api/muse/desktop/inbox' : `/api/muse/desktop/inbox?wait=${wait}`
  return api('GET', path, undefined, { timeoutMs: Math.max(45_000, ((wait ?? 0) + 20) * 1000) })
}

export async function desktopReply(options, args) {
  const key = uuidKey(args[0], '桌面来信 requestKey')
  const hasTextArg = args.length > 1
  const hasFile = options.file !== undefined
  if (hasTextArg === hasFile) {
    throw new Error('请提供回复文字（或 -），或使用 --file 传入 JSON 文件，两者二选一。')
  }
  if (options['drawing-ids'] !== undefined && options['drawing-file'] !== undefined) {
    throw new Error('--drawing-ids 和 --drawing-file 请只选一个。')
  }

  let body
  if (hasFile) {
    const fileData = checkPlainObject(await readInput(options.file, false), '桌面回复 JSON')
    if (fileData.requestKey !== undefined && fileData.requestKey !== key) {
      throw new Error('JSON 文件中的 requestKey 须与命令参数一致。')
    }
    body = { ...fileData, requestKey: key }
  } else {
    const text = args[1] === '-' ? await readStdin(64 * 1024, '桌面回复文字') : args[1]
    body = { requestKey: key, text }
  }

  if (options['drawing-ids'] !== undefined) {
    const ids = options['drawing-ids'].flatMap(value => value.split(',').map(id => id.trim()))
    if (!ids.length || ids.some(id => !id)) throw new Error('--drawing-ids 中的每个目录 ID 都不能为空。')
    body.drawing = { ids }
  } else if (options['drawing-file'] !== undefined) {
    body.drawing = await readInput(options['drawing-file'], false)
  }

  if (typeof body.text !== 'string') throw new Error('桌面回复缺少 text 字符串。')
  const trimmed = body.text.trim()
  const length = [...trimmed].length
  if (length < 1 || length > 12000) throw new Error('桌面回复文字须为 1–12000 字。')
  body.text = trimmed

  if (body.drawing !== undefined) checkDesktopDrawing(body.drawing)

  const allowedKeys = new Set(['requestKey', 'text', 'drawing'])
  if (Object.keys(body).some(k => !allowedKeys.has(k))) {
    throw new Error('桌面回复只接受 requestKey、text 和可选的 drawing 字段。')
  }

  try {
    return await api('POST', '/api/muse/desktop/reply', body)
  } catch (error) {
    error.requestKey = key
    throw error
  }
}

export async function qqInbox(options) {
  const wait = inboxWaitSeconds(options.wait)
  const path = wait === undefined ? '/api/muse/qq/inbox' : `/api/muse/qq/inbox?wait=${wait}`
  return api('GET', path, undefined, { timeoutMs: Math.max(45_000, ((wait ?? 0) + 20) * 1000) })
}

export async function qqTargets() {
  return api('GET', '/api/muse/qq/targets')
}

export async function qqContext(args) {
  const id = conversationId(args[0])
  return api('GET', `/api/muse/qq/context/${encodeURIComponent(id)}`)
}

export async function qqReply(options, args) {
  const key = requestKey(args[0])
  if (options.skip) {
    if (options.text !== undefined || options.image !== undefined || options.audio !== undefined || options.mention !== undefined) {
      throw new Error('--skip 时不能同时传 --text、--image、--audio 或 --mention。')
    }
    try {
      return await api('POST', '/api/muse/qq/reply', { requestKey: key, skip: true })
    } catch (error) {
      error.requestKey = key
      throw error
    }
  }

  if (options.image !== undefined && options.audio !== undefined) {
    throw new Error('一次 QQ 回复只能附带一张图片或一段语音。')
  }
  const textRaw = await readTextOption(options.text, 'QQ 回复文字')
  const text = textRaw === undefined ? undefined : textRaw.trim()
  if (text !== undefined) {
    const length = [...text].length
    if (length < 1 || length > 1600) throw new Error('QQ 回复文字须为 1–1600 字。')
  }
  if (text === undefined && options.image === undefined && options.audio === undefined) {
    throw new Error('请提供 --text、--image、--audio 中的至少一项，或传 --skip 跳过。')
  }
  if (options.mention !== undefined) {
    if (text === undefined) throw new Error('--mention 须配合 --text 一起使用。')
    if (!options.mention.trim()) throw new Error('--mention 需要有效的 senderId。')
  }

  const body = { requestKey: key }
  if (text !== undefined) body.text = text
  if (options.mention !== undefined) body.mentionSenderId = options.mention.trim()
  if (options.image !== undefined) body.image = await encodeQqImage(options.image)
  if (options.audio !== undefined) body.audio = await encodeQqAudio(options.audio)

  try {
    return await api('POST', '/api/muse/qq/reply', body, { timeoutMs: 90_000 })
  } catch (error) {
    error.requestKey = key
    throw error
  }
}

export async function qqSend(options, args) {
  const id = conversationId(args[0])
  const key = options.key === undefined ? randomUUID() : uuidKey(options.key, 'QQ 主动发送 --key')
  const textRaw = await readTextOption(options.text, 'QQ 发送文字')
  const provided = [textRaw !== undefined, options.image !== undefined, options.audio !== undefined].filter(Boolean).length
  if (provided !== 1) {
    throw new Error('QQ 主动发送须在 --text、--image、--audio 中严格选一项。')
  }
  if (options.mention !== undefined) {
    if (textRaw === undefined) throw new Error('--mention 须配合 --text 一起使用。')
    if (!options.mention.trim()) throw new Error('--mention 需要有效的 senderId。')
  }

  const body = { requestKey: key, conversationId: id }
  if (textRaw !== undefined) {
    const text = textRaw.trim()
    const length = [...text].length
    if (length < 1 || length > 1600) throw new Error('QQ 发送文字须为 1–1600 字。')
    body.text = text
    if (options.mention !== undefined) body.mentionSenderId = options.mention.trim()
  } else if (options.image !== undefined) {
    body.image = await encodeQqImage(options.image)
  } else {
    body.audio = await encodeQqAudio(options.audio)
  }

  try {
    return await api('POST', '/api/muse/qq/send', body, { timeoutMs: 90_000 })
  } catch (error) {
    error.requestKey = key
    throw error
  }
}

export async function qqSearch(options, args) {
  const query = args[0].trim()
  const length = [...query].length
  if (length < 1 || length > 400) throw new Error('搜索关键词须为 1–400 字。')

  let key
  const body = { query }
  if (options.conversation !== undefined) {
    body.conversationId = conversationId(options.conversation)
    key = options.key === undefined ? randomUUID() : uuidKey(options.key, '主动检索 --key')
  } else if (options.key !== undefined) {
    key = requestKey(options.key)
  } else {
    throw new Error('请传 --key 来信编号，或传 --conversation 会话 ID。')
  }
  body.requestKey = key

  try {
    return await api('POST', '/api/muse/qq/search', body, { timeoutMs: 45_000 })
  } catch (error) {
    error.requestKey = key
    throw error
  }
}

export async function runDesktop(subcommand, options, args) {
  if (subcommand === 'inbox') return desktopInbox(options)
  if (subcommand === 'reply') return desktopReply(options, args)
  throw new Error(`未知 desktop 子命令：${subcommand}`)
}

export async function runQq(subcommand, options, args) {
  switch (subcommand) {
    case 'inbox': return qqInbox(options)
    case 'targets': return qqTargets()
    case 'context': return qqContext(args)
    case 'reply': return qqReply(options, args)
    case 'send': return qqSend(options, args)
    case 'search': return qqSearch(options, args)
    default: throw new Error(`未知 qq 子命令：${subcommand}`)
  }
}

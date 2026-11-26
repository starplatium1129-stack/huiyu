export interface ChatStreamEvent {
  type: string
  model?: string
  matchedLore?: string[]
  content?: string
  speechFirst?: boolean
  /** 工具调用事件（type:'tool-call'）：index/id/name/arguments */
  index?: number
  id?: string
  name?: string
  arguments?: string
  drawing?: Record<string, unknown>
  /** Opaque Gemini tool signature; only replay within the current tool loop. */
  thoughtSignature?: string
}

export interface RoleplaySpeech {
  text: string
  directions: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseChatStreamEvent(value: unknown): ChatStreamEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  const matchedLore = Array.isArray(value.matchedLore)
    ? value.matchedLore.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 16)
    : undefined
  return {
    type: value.type,
    model: typeof value.model === 'string' ? value.model : undefined,
    matchedLore: matchedLore?.length ? matchedLore : undefined,
    content: typeof value.content === 'string' ? value.content : undefined,
    speechFirst: value.speechFirst === true || undefined,
    index: typeof value.index === 'number' ? value.index : undefined,
    id: typeof value.id === 'string' ? value.id : undefined,
    name: typeof value.name === 'string' ? value.name : undefined,
    arguments: typeof value.arguments === 'string' ? value.arguments : undefined,
    drawing: value.type === 'drawing' && isRecord(value.drawing) && !Array.isArray(value.drawing) ? value.drawing : undefined,
    thoughtSignature: typeof value.thoughtSignature === 'string' && value.thoughtSignature.length <= 65536 ? value.thoughtSignature : undefined,
  }
}

const EMOTION_NEGATION = '(?:不|没|别|没有|并不|不会|不用|不必|无需|不要|从不|毫不)(?:太|再|那么|这么|有点|有些|觉得|感到|是|算){0,2}'
const NEGATED_SHY = new RegExp(`${EMOTION_NEGATION}(?:害羞|羞涩|羞怯|羞赧|脸红|红着脸|红了脸|羞红|面红耳赤)`, 'g')
const NEGATED_HAPPY = new RegExp(`${EMOTION_NEGATION}(?:开心|高兴|快乐|兴奋|雀跃|大笑|笑起来|笑出声|笑我|笑)`, 'g')
const NEGATED_SAD = new RegExp(`${EMOTION_NEGATION}(?:难过|伤心|寂寞|失落|委屈|哭|对不起|抱歉)`, 'g')
const NEGATED_SERIOUS = new RegExp(`${EMOTION_NEGATION}(?:认真|严肃|紧张|危险|警惕)`, 'g')

export function inferEmotion(text: string, character = ''): string {
  // Strip negated cues and keep single-word triggers conservative so ordinary
  // clauses do not abruptly switch to an extreme reference clip mid-reply.
  const shyText = text.replace(NEGATED_SHY, '')
  if (/害羞|羞涩|羞怯|羞赧|脸红|红着脸|红了脸|羞红|面红耳赤/.test(shyText)) return 'shy'
  const happyText = text.replace(NEGATED_HAPPY, '')
  if (/开心|高兴|太好了|哈哈|嘻嘻|大笑|笑起来|笑出声|欢呼|挥手|雀跃/.test(happyText)) return 'happy'
  const sadText = text.replace(NEGATED_SAD, '')
  if (/难过|伤心|寂寞|失落|委屈|眼泪|哭了|叹气|对不起|很抱歉|真抱歉|实在抱歉/.test(sadText)) return 'sad'
  const seriousText = text.replace(NEGATED_SERIOUS, '')
  if (/认真|严肃|必须|危险|别逞强|皱眉|警惕|住手|绝对不行/.test(seriousText)) return 'serious'
  if (/温柔|谢谢|陪着|安心|辛苦|休息|没关系|微笑|轻轻|安抚|小心点|路上小心|注意身体|放心|抱抱/.test(text)) return 'gentle'
  if (character === 'natsume' && /真是的|算了|我在|放心/.test(text)) return 'gentle'
  return 'neutral'
}

import { stripChatMarkupForSpeech } from './chatMessageFormat'

/**
 * Roleplay models often prefix dialogue with directions such as
 * `（稍微有点慌乱）`. Keep those directions in the text transcript, but never
 * submit them to translation or TTS. They still feed the emotion classifier.
 */
export function extractSpokenDialogue(value: unknown): RoleplaySpeech {
  const directions: string[] = []
  const cleaned = stripChatMarkupForSpeech(String(value || ''))
  const text = cleaned.replace(
    /（([^（）\n]{1,120})）|\(([^()\n]{1,120})\)|【([^【】\n]{1,120})】|\[([^\[\]\n]{1,120})\]|(?:\*|＊)([^*＊\n]{1,120})(?:\*|＊)/g,
    (_all, roundCn, round, squareCn, square, stars) => {
      const direction = String(roundCn || round || squareCn || square || stars || '')
        .replace(/\s+/g, ' ')
        .trim()
      if (direction) directions.push(direction)
      return ' '
    },
  ).replace(/\s+/g, ' ').trim()
  return { text, directions }
}

export class SentenceBuffer {
  minimumLength: number
  maximumLength: number
  immediateFirst: boolean
  firstThreshold: number
  buffer = ''
  short = ''
  emitted = 0

  constructor(options: { minimumLength?: number; maximumLength?: number; immediateFirst?: boolean; firstThreshold?: number } = {}) {
    this.minimumLength = options.minimumLength ?? 4
    this.maximumLength = options.maximumLength ?? 100
    this.immediateFirst = Boolean(options.immediateFirst)
    // 首句单独阈值：对话开场白通常短，等满 minimumLength 才放行会拖慢
    // 第一句语音；达到 firstThreshold 的首句立即合成（默认等同 minimumLength，
    // 不传即保持原行为）。
    this.firstThreshold = options.firstThreshold ?? options.minimumLength ?? 4
  }

  reset() { this.buffer = ''; this.short = ''; this.emitted = 0 }

  push(fragment: string, flush = false): string[] {
    this.buffer += String(fragment || '')
    const complete: string[] = []
    let start = 0
    for (let i = 0; i < this.buffer.length; i++) {
      const boundary = /[。！？!?；;\n]/.test(this.buffer[i])
      const forced = i - start + 1 >= this.maximumLength && /[，、,\s]/.test(this.buffer[i])
      if (!boundary && !forced) continue
      const s = this.buffer.slice(start, i + 1).trim()
      if (s) complete.push(s)
      start = i + 1
    }
    this.buffer = this.buffer.slice(start)
    if (this.buffer.length >= this.maximumLength) {
      complete.push(this.buffer.slice(0, this.maximumLength).trim())
      this.buffer = this.buffer.slice(this.maximumLength)
    }
    if (flush && this.buffer.trim()) { complete.push(this.buffer.trim()); this.buffer = '' }
    const output: string[] = []
    complete.forEach((sentence, idx) => {
      const val = this.short + sentence; this.short = ''
      const isLast = idx === complete.length - 1
      const first = this.emitted === 0
      const allowShort = (this.immediateFirst && first) || (first && val.length >= this.firstThreshold)
      if (!flush && isLast && !allowShort && val.length < this.minimumLength) { this.short = val }
      else { output.push(val); this.emitted++ }
    })
    if (flush && this.short) { output.push(this.short); this.emitted++; this.short = '' }
    return output.filter(Boolean)
  }
}

async function errorFromResponse(response: Response, fallback: string): Promise<Error> {
  const text = await response.text()
  try {
    const parsed: unknown = JSON.parse(text)
    const data = isRecord(parsed) ? parsed : {}
    const message = typeof data.error === 'string' && data.error ? data.error : fallback
    const detail = typeof data.detail === 'string' ? data.detail : ''
    const code = typeof data.code === 'string' ? data.code : ''
    const error = Object.assign(new Error(message), { detail, ...(code ? { code } : {}),
      ...(isRecord(data.upstream) ? { upstream: data.upstream } : {}),
    })
    return error
  } catch {
    return new Error(text.trim() || fallback)
  }
}

export async function parseNdjsonResponse(response: Response, onEvent: (event: ChatStreamEvent) => Promise<void> | void): Promise<void> {
  if (!response.ok) throw await errorFromResponse(response, '聊天请求失败')
  if (!response.body || typeof response.body.getReader !== 'function') throw new Error('当前浏览器不支持流式聊天')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  // 2026-08-16 审计：流必须收到终止事件（done/error）才算正常结束——服务端进程
  // 崩溃/连接被掐时 reader 会以 done 结束但没有任何终止事件，此前会静默截断
  // 对话（用户看到回复说了一半）。缺终止事件一律按「意外中断」抛错。
  let sawTerminal = false
  const consume = async (line: string) => {
    if (!line.trim()) return
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { throw new Error('聊天流返回了无效数据') }
    if (isRecord(parsed) && parsed.type === 'error') {
      const code = typeof parsed.code === 'string' ? parsed.code : ''
      const message = typeof parsed.error === 'string' && parsed.error ? parsed.error : '聊天流中断'
      throw Object.assign(new Error(message), code ? { code } : {},
        isRecord(parsed.upstream) ? { upstream: parsed.upstream } : {})
    }
    const event = parseChatStreamEvent(parsed)
    if (!event) throw new Error('聊天流返回了无效事件')
    if (event.type === 'done') sawTerminal = true
    await onEvent(event)
  }
  try {
    while (!sawTerminal) {
      const result = await reader.read()
      buffer += decoder.decode(result.value || new Uint8Array(), { stream: !result.done })
      const lines = buffer.split('\n'); buffer = lines.pop()!
      for (const line of lines) {
        await consume(line)
        if (sawTerminal) break
      }
      if (result.done) break
    }
    buffer += decoder.decode()
    if (!sawTerminal && buffer.trim()) await consume(buffer)
    if (!sawTerminal) throw new Error('聊天流意外中断（未收到完成事件）')
  } finally {
    // 完成事件或消费失败后立即释放连接，不等待服务端继续关闭流。
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function isAbortError(error: unknown): boolean {
  return isRecord(error) && (error.name === 'AbortError' || error.code === 'ABORT_ERR')
}

export function streamErrorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === 'string' ? error.code : ''
}

export function streamErrorMessage(error: unknown, fallback: string): string {
  if (!isRecord(error)) return error instanceof Error && error.message ? error.message : fallback
  const message = typeof error.message === 'string' ? error.message : ''
  const detail = typeof error.detail === 'string' ? error.detail : ''
  return (detail ? `${message || fallback}：${detail}` : message) || fallback
}

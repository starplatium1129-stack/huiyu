export interface ChatStreamEvent {
  type: string
  model?: string
  content?: string
  /** 工具调用事件（type:'tool-call'）：index/id/name/arguments */
  index?: number
  id?: string
  name?: string
  arguments?: string
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
  return {
    type: value.type,
    model: typeof value.model === 'string' ? value.model : undefined,
    content: typeof value.content === 'string' ? value.content : undefined,
    index: typeof value.index === 'number' ? value.index : undefined,
    id: typeof value.id === 'string' ? value.id : undefined,
    name: typeof value.name === 'string' ? value.name : undefined,
    arguments: typeof value.arguments === 'string' ? value.arguments : undefined,
  }
}

export function inferEmotion(text: string, character = ''): string {
  if (/害羞|脸红|不好意思|才不是|笨蛋|慌乱|紧张|犹豫|小声|吞吞吐吐/.test(text)) return 'shy'
  if (/开心|高兴|太好了|哈哈|笑|期待|终于|挥手|雀跃/.test(text)) return 'happy'
  if (/难过|寂寞|想念|对不起|抱歉|失落|叹气/.test(text)) return 'sad'
  if (/认真|必须|小心|危险|不许|别逞强|注意|皱眉|警惕/.test(text)) return 'serious'
  if (/温柔|谢谢|陪着|安心|辛苦|休息|没关系|微笑|轻轻|安抚/.test(text)) return 'gentle'
  if (character === 'nene' && /那个|其实|愿意|可以吗/.test(text)) return 'shy'
  if (character === 'natsume' && /真是的|算了|我在|放心/.test(text)) return 'gentle'
  return 'neutral'
}

/**
 * Roleplay models often prefix dialogue with directions such as
 * `（稍微有点慌乱）`. Keep those directions in the text transcript, but never
 * submit them to translation or TTS. They still feed the emotion classifier.
 */
export function extractSpokenDialogue(value: unknown): RoleplaySpeech {
  const directions: string[] = []
  const text = String(value || '').replace(
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

export function fixWavHeader(buffer: ArrayBuffer): ArrayBuffer {
  try {
    const view = new DataView(buffer)
    if (buffer.byteLength < 44) return buffer
    if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) return buffer
    view.setUint32(4, buffer.byteLength - 8, true)
    let position = 12
    while (position + 8 <= buffer.byteLength) {
      const tag = view.getUint32(position, false)
      const size = view.getUint32(position + 4, true)
      if (tag === 0x64617461) { view.setUint32(position + 4, buffer.byteLength - position - 8, true); break }
      if (size > buffer.byteLength || position + 8 + size > buffer.byteLength + 1) break
      position += 8 + size + (size % 2)
    }
  } catch {}
  return buffer
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
    const error = Object.assign(new Error(message), { detail })
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
      throw new Error(typeof parsed.error === 'string' && parsed.error ? parsed.error : '聊天流中断')
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

export function streamErrorMessage(error: unknown, fallback: string): string {
  if (!isRecord(error)) return error instanceof Error && error.message ? error.message : fallback
  const message = typeof error.message === 'string' ? error.message : ''
  const detail = typeof error.detail === 'string' ? error.detail : ''
  return (detail ? `${message || fallback}：${detail}` : message) || fallback
}

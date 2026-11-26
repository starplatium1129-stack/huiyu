export type ChatInlineToken =
  | { type: 'text'; text: string }
  | { type: 'link'; text: string; href: string }
  | { type: 'strong'; text: string }
  | { type: 'em'; text: string }
  | { type: 'code'; text: string }
  | { type: 'del'; text: string }

export type ChatMessageBlock =
  | {
      type: 'disclosure'
      kind: 'status' | 'think' | 'details'
      title: string
      raw: string
      rows?: Array<{ label: string; value: string }>
      paragraphs: ChatInlineToken[][]
    }
  | { type: 'code'; lang: string; code: string }
  | { type: 'blockquote'; paragraphs: ChatInlineToken[][] }
  | { type: 'hr' }
  | { type: 'paragraph'; inlines: ChatInlineToken[] }

function parseSafeUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

function parsePlainWithFormatting(text: string): ChatInlineToken[] {
  const tokens: ChatInlineToken[] = []
  const pattern = /`([^`\r\n]{1,300})`|(?:\*\*|__)([^*\r\n][\s\S]{0,600}?[^*\r\n]?)(?:\*\*|__)|~~([^~\r\n]{1,600})~~|\*([^*\r\n]{1,600})\*/g
  let offset = 0
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > offset) tokens.push({ type: 'text', text: text.slice(offset, start) })
    if (match[1] !== undefined) tokens.push({ type: 'code', text: match[1] })
    else if (match[2] !== undefined) tokens.push({ type: 'strong', text: match[2] })
    else if (match[3] !== undefined) tokens.push({ type: 'del', text: match[3] })
    else if (match[4] !== undefined) tokens.push({ type: 'em', text: match[4] })
    offset = start + match[0].length
  }
  if (offset < text.length) tokens.push({ type: 'text', text: text.slice(offset) })
  return tokens
}

export function parseChatInlines(text: string): ChatInlineToken[] {
  const result: ChatInlineToken[] = []
  const links = /\[([^\]\r\n]{1,200})\]\((https?:\/\/(?:[^\s<>()]|\([^\s<>()]*\))+)\)|(https?:\/\/[^\s<>]+)/g
  let offset = 0
  for (const match of text.matchAll(links)) {
    const start = match.index ?? 0
    if (start > offset) result.push(...parsePlainWithFormatting(text.slice(offset, start)))
    let raw = match[2] || match[3].replace(/[.,;!?，。；！？）]+$/, '')
    if (!match[2]) {
      while (raw.endsWith(')') && raw.split(')').length > raw.split('(').length) raw = raw.slice(0, -1)
    }
    const href = parseSafeUrl(raw)
    if (href) {
      result.push({ type: 'link', text: match[1] || raw, href })
      if (!match[2] && raw.length < match[0].length) {
        result.push(...parsePlainWithFormatting(match[0].slice(raw.length)))
      }
    } else {
      result.push(...parsePlainWithFormatting(match[0]))
    }
    offset = start + match[0].length
  }
  if (offset < text.length) result.push(...parsePlainWithFormatting(text.slice(offset)))
  return result
}

function parseStatusRows(body: string): Array<{ label: string; value: string }> | undefined {
  const lines = body
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  if (!lines.length || lines.length > 24) return undefined
  const rows: Array<{ label: string; value: string }> = []
  for (const line of lines) {
    const clean = line.replace(/^[-*•]\s*/, '')
    const match = clean.match(/^([^:：\n]{1,30})[：:]\s*(.+)$/)
    if (!match) return undefined
    rows.push({ label: match[1].trim(), value: match[2].trim() })
  }
  return rows.length ? rows : undefined
}

function toParagraphInlines(text: string): ChatInlineToken[][] {
  return text
    .split(/\r?\n(?:[ \t]*\r?\n)+/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => parseChatInlines(part))
}

function parseTextLines(segment: string): ChatMessageBlock[] {
  const blocks: ChatMessageBlock[] = []
  const lines = segment.split(/\r?\n/)
  let index = 0
  let paragraphLines: string[] = []

  const flushParagraph = () => {
    const text = paragraphLines.join('\n').trim()
    paragraphLines = []
    if (text) blocks.push({ type: 'paragraph', inlines: parseChatInlines(text) })
  }

  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()

    if (!trimmed) {
      flushParagraph()
      index += 1
      continue
    }

    const fenceMatch = trimmed.match(/^(?:```|~~~)\s*([\w.+-]*)\s*$/)
    if (fenceMatch) {
      flushParagraph()
      const fence = trimmed.slice(0, 3)
      const lang = fenceMatch[1] || ''
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith(fence)) {
        codeLines.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push({ type: 'code', lang, code: codeLines.join('\n') })
      continue
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph()
      blocks.push({ type: 'hr' })
      index += 1
      continue
    }

    if (/^>\s?/.test(trimmed)) {
      flushParagraph()
      const quoteLines: string[] = []
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ''))
        index += 1
      }
      const quoteText = quoteLines.join('\n').trim()
      if (quoteText) blocks.push({ type: 'blockquote', paragraphs: toParagraphInlines(quoteText) })
      continue
    }

    paragraphLines.push(line)
    index += 1
  }
  flushParagraph()
  return blocks
}

export function parseChatMessageBlocks(source: string): ChatMessageBlock[] {
  if (!source) return []
  const blocks: ChatMessageBlock[] = []
  const tagRegex = /<(status|think|thought|details)\b[^>]*>([\s\S]*?)(?:<\/\1>|$)/gi
  let offset = 0

  for (const match of source.matchAll(tagRegex)) {
    const start = match.index ?? 0
    if (start > offset) blocks.push(...parseTextLines(source.slice(offset, start)))
    const tag = match[1].toLowerCase()
    let body = match[2].trim()
    let title = tag === 'status' ? '当前状态' : tag === 'details' ? '展开详情' : '内心思考'
    const kind: 'status' | 'think' | 'details' =
      tag === 'status' ? 'status' : tag === 'details' ? 'details' : 'think'

    if (tag === 'details') {
      const summaryMatch = body.match(/^<summary\b[^>]*>([\s\S]*?)<\/summary>/i)
      if (summaryMatch) {
        const customTitle = summaryMatch[1].replace(/<[^>]+>/g, '').trim()
        if (customTitle) title = customTitle.slice(0, 80)
        body = body.slice(summaryMatch[0].length).trim()
      }
    }

    if (body) {
      blocks.push({
        type: 'disclosure',
        kind,
        title,
        raw: body,
        rows: kind === 'status' ? parseStatusRows(body) : undefined,
        paragraphs: toParagraphInlines(body),
      })
    }
    offset = start + match[0].length
  }

  if (offset < source.length) blocks.push(...parseTextLines(source.slice(offset)))
  return blocks
}

export function stripChatMarkupForSpeech(value: string): string {
  return value
    .replace(/<(status|think|thought|details)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, ' ')
    .replace(/(?:```|~~~)[\s\S]*?(?:```|~~~|$)/g, ' ')
    .replace(/`([^`\r\n]+)`/g, '$1')
    .replace(/\[([^\]\r\n]{1,200})\]\(https?:\/\/[^\s)]+\)/g, '$1')
    .replace(/(?:\*\*|__|~~)/g, '')
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*_]{3,}[ \t]*$)/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

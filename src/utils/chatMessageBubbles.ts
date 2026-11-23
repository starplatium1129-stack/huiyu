import type { ChatMessage } from '@/composables/chat/chatStorageTypes'

const targetLength = 44
const minimumLength = 20
const formattedReply = /^[ \t]*(?:`{3,}|~{3,}|#{1,6}[ \t]|>[ \t]?|\||(?:[-*+]|\d+[.)])[ \t])/m

export function chatMessageBubbles(message: ChatMessage): string[] {
  const { content } = message
  if (message.role === 'user' || message.drawingBatchId || message.drawingDrafts?.length
    || message.images?.length || formattedReply.test(content)) return [content]

  const paragraphs = content.trim().split(/\r?\n(?:[ \t]*\r?\n)+/)
  return paragraphs.flatMap(splitLongParagraph)
}

function splitLongParagraph(paragraph: string): string[] {
  if (paragraph.length <= targetLength || /https?:\/\//i.test(paragraph)) return [paragraph]

  const bubbles: string[] = []
  let start = 0
  let previousEnd = 0
  const pushThrough = (end: number) => {
    bubbles.push(paragraph.slice(start, end).trim())
    start = end
  }

  // Keep conversational sentences whole, including their closing quotes.
  for (const boundary of paragraph.matchAll(/(?:[。！？!?]+|\.(?=\s|$)|…{2,})[」』）》】”’"']*/g)) {
    const end = boundary.index + boundary[0].length
    if (end - start > targetLength && previousEnd - start >= minimumLength) pushThrough(previousEnd)
    if (end - start >= targetLength) pushThrough(end)
    previousEnd = end
  }
  if (paragraph.length - start > targetLength && previousEnd - start >= minimumLength) pushThrough(previousEnd)
  const tail = paragraph.slice(start).trim()
  if (tail) bubbles.push(tail)
  return bubbles
}

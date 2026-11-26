import { parseCompanionChatImages, parseCompanionDrawingBatchId, parseCompanionDrawingDraft, type CompanionDrawingDraft } from '@/types/companionDrawing'
import type { ChatMessage, ChatReplyVariant } from '@/composables/chat/chatStorageTypes'

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : ''
export const cloneChatMessages = (messages: ChatMessage[]): ChatMessage[] => JSON.parse(JSON.stringify(messages))
export const chatMessageKey = (message: ChatMessage) => message.replyId || message.mid
export function canRegenerateChatMessage(messages: readonly ChatMessage[], mid: string): boolean {
  const index = messages.findIndex(message => message.mid === mid)
  if (index < 0) return false
  return messages[index].role === 'user' ? index === messages.length - 1
    : messages.slice(0, index).some(message => message.role === 'user')
}
export function replySnapshot(message: ChatReplyVariant): ChatReplyVariant {
  const { mid, content, stopped, recalledMemories, matchedLore, drawingDrafts, drawingBatchId, images } = message
  return JSON.parse(JSON.stringify({ mid, content, stopped, ...(recalledMemories?.length ? { recalledMemories } : {}),
    ...(matchedLore?.length ? { matchedLore } : {}),
    ...(drawingDrafts?.length ? { drawingDrafts } : {}), ...(drawingBatchId ? { drawingBatchId } : {}), ...(images?.length ? { images } : {}) }))
}
export function applyReplyVariant(message: ChatMessage, variant: ChatReplyVariant) {
  const snapshot = replySnapshot(variant)
  delete message.recalledMemories; delete message.matchedLore; delete message.drawingDrafts; delete message.drawingBatchId; delete message.images
  Object.assign(message, snapshot)
}
function normalizeVariant(value: unknown, createId: () => string): ChatReplyVariant | null {
  if (!object(value)) return null
  const content = text(value.content, 60_000)
  const drawingBatchId = parseCompanionDrawingBatchId(value.drawingBatchId)
  if (!content && !drawingBatchId) return null
  const recalledMemories = Array.isArray(value.recalledMemories) ? value.recalledMemories.map(item => text(item, 240)).filter(Boolean).slice(0, 6) : []
  const matchedLore = Array.isArray(value.matchedLore) ? value.matchedLore.map(item => text(item, 80)).filter(Boolean).slice(0, 16) : []
  const drawingDrafts = Array.isArray(value.drawingDrafts) ? value.drawingDrafts.map(parseCompanionDrawingDraft)
    .filter((item): item is CompanionDrawingDraft => Boolean(item)).slice(-4) : []
  const images = parseCompanionChatImages(value.images)
  return { mid: text(value.mid, 160) || text(value.id, 160) || createId(), content, stopped: value.stopped === true,
    ...(recalledMemories.length ? { recalledMemories } : {}),
    ...(matchedLore.length ? { matchedLore } : {}),
    ...(drawingDrafts.length ? { drawingDrafts } : {}),
    ...(drawingBatchId ? { drawingBatchId } : {}), ...(images.length ? { images } : {}) }
}
export function normalizeChatMessage(value: unknown, createId: () => string): ChatMessage | null {
  if (!object(value) || (value.role !== 'user' && value.role !== 'assistant')) return null
  const variants = value.role === 'assistant' && Array.isArray(value.variants)
    ? value.variants.map(item => normalizeVariant(item, createId)).filter((item): item is ChatReplyVariant => Boolean(item)) : []
  const selected = normalizeVariant(value, createId) || variants.at(-1)
  if (!selected) return null
  const message: ChatMessage = { role: value.role, ...selected }
  if (value.role === 'assistant') {
    message.replyId = text(value.replyId, 160) || selected.mid
    if (variants.length) message.variants = mergeReplyVariants(variants, [selected])
  }
  return message
}
export function normalizeChatMessages(value: unknown, max: number, createId: () => string): ChatMessage[] {
  return Array.isArray(value) ? value.map(item => normalizeChatMessage(item, createId)).filter((item): item is ChatMessage => Boolean(item)).slice(-max) : []
}
export function mergeReplyVariants(...lists: ChatReplyVariant[][]): ChatReplyVariant[] {
  const variants = new Map<string, ChatReplyVariant>()
  for (const list of lists) for (const variant of list) if (variant.mid && (variant.content || variant.drawingBatchId)) variants.set(variant.mid, replySnapshot(variant))
  return [...variants.values()]
}

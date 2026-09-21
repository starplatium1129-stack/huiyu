/**
 * 聊天记忆归档 —— 纯逻辑核心。
 *
 * 对话 trim 到 20 条前的旧消息不再直接丢弃，而是先归档到
 * `aics_chat_archive_v1`（localStorage），并支持 JSON / Markdown 导出、
 * 导入合并与"并入当前对话"恢复。归档上限按角色 5000 条，
 * 防止 localStorage 无界增长（约 1MB/角色，处于安全余量内）。
 */
import type { PersistedChatMessage } from './chatStorageCore'
import { assertChatVersion } from './chatVersion.ts'

export const CHAT_ARCHIVE_KEY = 'aics_chat_archive_v1'
export const CHAT_ARCHIVE_VERSION = 1
export const CHAT_ARCHIVE_MAX_PER_CHAR = 5000

export interface ChatArchive {
  version: number
  archived: Record<string, PersistedChatMessage[]>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function normalizeMessage(value: unknown): PersistedChatMessage | null {
  if (!isRecord(value)) return null
  const role = value.role === 'user' || value.role === 'assistant' ? value.role : ''
  if (!role) return null
  const content = text(value.content, 1200)
  if (!content) return null
  return {
    role,
    content,
    mid: text(value.mid, 160) || text(value.id, 160) || '',
    stopped: value.stopped === true,
  }
}

function normalizeMessages(value: unknown): PersistedChatMessage[] {
  if (!Array.isArray(value)) return []
  return value
    .map(normalizeMessage)
    .filter((item): item is PersistedChatMessage => Boolean(item))
}

export function emptyChatArchive(characterIds: string[]): ChatArchive {
  const archived: Record<string, PersistedChatMessage[]> = {}
  for (const id of characterIds.length ? characterIds : ['nene']) archived[id] = []
  return { version: CHAT_ARCHIVE_VERSION, archived }
}

export function normalizeChatArchive(value: unknown, characterIds: string[]): ChatArchive {
  assertChatVersion(value, CHAT_ARCHIVE_VERSION)
  const archive = emptyChatArchive(characterIds)
  const raw = isRecord(value) ? value : {}
  const archived = isRecord(raw.archived) ? raw.archived : {}
  for (const id of Object.keys(archive.archived)) {
    archive.archived[id] = normalizeMessages(archived[id]).slice(-CHAT_ARCHIVE_MAX_PER_CHAR)
  }
  return archive
}

export function serializeChatArchive(archive: ChatArchive): string {
  return JSON.stringify({
    version: CHAT_ARCHIVE_VERSION,
    archived: archive.archived,
  })
}

function messageKey(message: PersistedChatMessage): string | null {
  return message.mid ? `mid:${message.mid}` : null
}

/** 追加被 trim 掉的消息；有 mid 时去重，无 mid 的旧消息宁可保留重复也不误删。 */
export function archiveMessages(
  archive: ChatArchive,
  characterId: string,
  removed: PersistedChatMessage[],
): ChatArchive {
  if (!archive.archived[characterId]) archive.archived[characterId] = []
  const seen = new Set(archive.archived[characterId].map(messageKey).filter((key): key is string => Boolean(key)))
  const additions: PersistedChatMessage[] = []
  for (const message of removed) {
    const key = messageKey(message)
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    additions.push(message)
  }
  if (additions.length) {
    archive.archived[characterId] = [
      ...archive.archived[characterId],
      ...additions,
    ].slice(-CHAT_ARCHIVE_MAX_PER_CHAR)
  }
  return archive
}

export function archiveCounts(archive: ChatArchive, characterIds: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const id of characterIds) counts[id] = (archive.archived[id] || []).length
  return counts
}

/** 把归档消息并回当前对话：有 mid 时去重，保持归档顺序。 */
export function mergeArchiveIntoHistory(
  history: PersistedChatMessage[],
  archived: PersistedChatMessage[],
): PersistedChatMessage[] {
  const seen = new Set(history.map(messageKey).filter((key): key is string => Boolean(key)))
  const additions: PersistedChatMessage[] = []
  for (const message of archived) {
    const key = messageKey(message)
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    additions.push(message)
  }
  return [...history, ...additions]
}

/** 合并两个归档（导入用）：按角色、按 mid/内容去重。 */
export function mergeChatArchives(current: ChatArchive, incoming: ChatArchive): ChatArchive {
  const merged = emptyChatArchive(Object.keys(current.archived))
  for (const characterId of Object.keys(merged.archived)) {
    merged.archived[characterId] = archiveMessages(
      { version: CHAT_ARCHIVE_VERSION, archived: { [characterId]: [] } },
      characterId,
      [...(current.archived[characterId] || []), ...(incoming.archived[characterId] || [])],
    ).archived[characterId] || []
  }
  return merged
}

/** 生成人类可读的 Markdown 归档文件。 */
export function chatArchiveToMarkdown(
  archive: ChatArchive,
  characterNames: Record<string, string>,
): string {
  const lines: string[] = ['# 角色聊天归档', '', '> 由 绘遇 导出 · 仅保存对话文本与停止标记', '']
  for (const [characterId, messages] of Object.entries(archive.archived)) {
    const name = characterNames[characterId] || characterId
    lines.push(`## ${name}（${messages.length} 条）`, '')
    if (!messages.length) {
      lines.push('*暂无归档*', '')
      continue
    }
    for (const message of messages) {
      const speaker = message.role === 'user' ? '你' : name
      const suffix = message.stopped ? ' *(中断)*' : ''
      lines.push(`**${speaker}**${suffix}：${message.content}`, '')
    }
  }
  return lines.join('\n').trimEnd() + '\n'
}

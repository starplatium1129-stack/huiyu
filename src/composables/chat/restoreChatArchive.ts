import { flushProfileWrites, profileRuntimeActive } from '@/platform/web/profileStorage'
import { mergeArchiveIntoHistory } from '@/utils/chatArchive'
import { chatResetRevision } from '@/utils/chatReset'
import { withChatTurn } from '@/utils/chatTurnOwnership'
import type { ChatMessage } from './chatStorageTypes'

/** Restoring live history shares the writer with replies and story edits. */
export async function restoreChatArchive(access: {
  current: () => boolean
  refresh: () => boolean
  readArchive: () => Promise<ChatMessage[]>
  history: () => ChatMessage[]
  replaceHistory: (history: ChatMessage[]) => void
  save: () => boolean
}): Promise<number> {
  const reset = chatResetRevision(), runtime = profileRuntimeActive()
  const current = () => access.current() && reset === chatResetRevision() && runtime === profileRuntimeActive()
  const refresh = () => {
    if (!current() || !access.refresh() || !current()) throw new Error('当前剧情或聊天资料已变化，请重新并入归档。')
  }
  let added = 0
  await withChatTurn(async () => {
    refresh()
    const archived = await access.readArchive()
    refresh()
    if (!archived.length) return
    const history = access.history()
    const merged = mergeArchiveIntoHistory(history, archived)
    added = merged.length - history.length
    if (JSON.stringify(merged) !== JSON.stringify(history)) {
      // Keep the complete history and the source archive; a later trim deduplicates it.
      access.replaceHistory(merged)
      const restoring = access.history()
      if (!access.save()) {
        if (access.history() === restoring) access.replaceHistory(history)
        throw new Error('并入的对话尚未保存，原归档已保留，请重试。')
      }
    }
    // save() publishes synchronously before this await. The existing profile
    // outbox owns confirmation and retry; a failed flush retains retryable state.
    await flushProfileWrites()
    if (!current()) throw new Error('当前剧情或聊天资料已变化，请重新并入归档。')
  }, () => { throw new Error('聊天正在回复或整理剧情，请等当前操作结束后再并入归档。') })
  return added
}

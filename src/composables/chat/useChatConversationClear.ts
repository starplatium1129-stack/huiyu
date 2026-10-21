import { computed, onScopeDispose, ref, shallowReactive, watch, type Ref } from 'vue'
import { flushProfileWrites, profileRuntimeActive } from '@/platform/web/profileStorage'
import { chatResetRevision } from '@/utils/chatReset'
import { withChatTurn } from '@/utils/chatTurnOwnership'
import { confirmAction } from '@/composables/useConfirm'
import { CHAT_RESET_KEY } from '@/utils/storageKeys'
import type { useChatStorage } from './useChatStorage'

interface ClearIntent { reset: string; revision: number; runtime: boolean }

/** Retrying a clear confirms its original queued write, never deletes newer messages. */
export function useChatConversationClear(options: {
  storage: ReturnType<typeof useChatStorage>
  activeChar: Ref<string>
  isBusy: () => boolean
  clearDraftInput: () => void
  clearAudio: (mids: string[]) => void
  notice: (message: string, kind?: string, timeout?: number) => void
}) {
  const { storage, activeChar } = options
  const clearBusy = ref(false)
  const pending = shallowReactive(new Map<string, ClearIntent>())
  const key = (character: string, branch: string) => JSON.stringify([character, branch])
  const clearLabel = computed(() => clearBusy.value ? '正在确认清空…'
    : pending.has(key(activeChar.value, storage.branchId(activeChar.value))) ? '重试确认清空' : '新对话')
  let alive = true, visit = 0
  watch(activeChar, () => { visit++ }, { flush: 'sync' })
  const historyRevision = (character: string) => storage.state.historiesRevisions[character] ?? storage.state.historiesRevision
  const confirmation = new AbortController()
  function forgetSuperseded() {
    const reset = chatResetRevision()
    for (const [id, intent] of pending) if (intent.reset !== reset) pending.delete(id)
  }
  function onStorage(event: StorageEvent) { if (event.key === CHAT_RESET_KEY || event.key === null) forgetSuperseded() }
  window.addEventListener('storage', onStorage)
  onScopeDispose(() => { alive = false; confirmation.abort(); pending.clear(); window.removeEventListener('storage', onStorage) })

  async function clearCharacterConversation() {
    if (!alive || clearBusy.value || options.isBusy()) return
    const character = activeChar.value, branch = storage.branchId(character), id = key(character, branch)
    let intent = pending.get(id)
    // An explicit whole-chat reset supersedes an old retry, not a new clear request.
    if (intent && (intent.reset !== chatResetRevision() || intent.runtime !== profileRuntimeActive())) { pending.delete(id); return }
    if (!storage.canWrite() || (!intent && !storage.messages(character).length)) return
    const reset = chatResetRevision(), runtime = profileRuntimeActive(), expectedVisit = visit
    const selection = storage.state.conversations[character]?.selectionRevision
    const viewingTarget = () => alive && visit === expectedVisit && activeChar.value === character
      && storage.branchId(character) === branch && storage.state.conversations[character]?.selectionRevision === selection
    clearBusy.value = true
    try {
      if (!intent) {
        const confirmed = await confirmAction({
          title: '清空当前对话？',
          message: '将清空当前剧情的对话记录并重新开始。其他剧情和历史归档会保留，此操作无法撤销。',
          confirmLabel: '清空对话', danger: true, signal: confirmation.signal,
        })
        if (!confirmed || !viewingTarget() || reset !== chatResetRevision() || runtime !== profileRuntimeActive()) return
      }
      await withChatTurn(async () => {
        if (!alive || options.isBusy() || !storage.refresh() || reset !== chatResetRevision() || runtime !== profileRuntimeActive()) return
        if (!intent) {
          if (!viewingTarget()) return
          const mids = storage.messages(character).map(message => message.mid).filter(Boolean)
          if (!storage.clear(character)) {
            options.notice('清空未完成，请保持窗口打开并检查存储后重试。', 'warning', 0)
            return
          }
          intent = { reset, revision: historyRevision(character), runtime }
          pending.set(id, intent)
          // Only acceptance clears the old input. Neither settlement nor retry touches new typing.
          options.clearDraftInput()
          storage.setDraft(character, '')
          options.clearAudio(mids)
        }
        await flushProfileWrites()
        if (pending.get(id) !== intent) return
        if (!storage.refresh()) { forgetSuperseded(); return }
        pending.delete(id)
        if (reset !== chatResetRevision() || runtime !== profileRuntimeActive() || historyRevision(character) !== intent.revision) { forgetSuperseded(); return }
        if (viewingTarget()) options.notice('此前清空已确认，后续对话和输入已保留。', 'info', 3000)
      }, () => {
        if (viewingTarget()) options.notice('另一个聊天窗口正在回复，请等回复结束后再确认清空。', 'info')
      })
    } catch {
      if (reset !== chatResetRevision()) forgetSuperseded()
      else if (viewingTarget()) options.notice(intent
        ? '清空尚未确认，请保持窗口打开并点击“重试确认清空”；重试不会删除之后的新消息或输入。'
        : '清空尚未接收，请检查存储后重试。', 'warning', 0)
    } finally { clearBusy.value = false }
  }

  return { clearBusy, clearLabel, clearCharacterConversation, forgetSuperseded }
}

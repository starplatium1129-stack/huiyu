import { nextTick } from 'vue'
import { flushProfileWrites } from '@/platform/web/profileStorage'
import { canRegenerateChatMessage } from '@/utils/chatMessageStorage'
import { CHAT_TURN_KEY } from '@/utils/storageKeys'
import type { ChatStoryAction } from '@/types/companionDrawing'
import type { StoryActionOptions } from './useChatStoryActions'

/** Loaded only for a story edit, after the shared conversation writer is acquired. */
export async function editChatStory(options: StoryActionOptions, action: ChatStoryAction, context: {
  character: string
  branch: string
  current: () => boolean
  acknowledge: (accepted: boolean) => boolean | void
}) {
  const { storage, activeChar, busy } = options
  const { character, branch, current, acknowledge } = context
  if (!current() || activeChar.value !== character || busy.value || !storage.refresh() || storage.branchId(character) !== branch) {
    acknowledge(false)
    if (current()) options.notice('当前剧情已变化，请在最新对话中重新选择。', 'info')
    return
  }
  const messages = storage.messages(character)
  if (action.kind === 'switch-branch' && action.branchId === branch) { acknowledge(true); return }
  const target = action.kind === 'switch-branch' ? undefined : messages.find(message => message.mid === action.messageId)
  if (action.kind !== 'switch-branch' && !target) { acknowledge(false); return }
  if (action.kind === 'regenerate' && (!options.chatReady.value || !canRegenerateChatMessage(messages, action.messageId))) { acknowledge(false); return }
  if (action.kind === 'continue' && (!options.chatReady.value || target !== messages.at(-1) || target!.role !== 'assistant' || !target!.content.trim())) { acknowledge(false); return }
  if (action.kind === 'edit' && !action.content.trim()) { acknowledge(false); return }
  if (action.kind === 'select-variant' && (target!.role !== 'assistant'
    || !target!.variants?.some(variant => variant.mid === action.variantId))) { acknowledge(false); return }
  if (action.kind === 'select-variant' && target!.mid === action.variantId) { acknowledge(true); return }
  if (acknowledge(true) === false) return
  options.stopVoice()
  try { localStorage.setItem(CHAT_TURN_KEY, String(Date.now())) } catch { /* Playback coordination is optional. */ }
  let changed = true, forked = false
  if (action.kind === 'switch-branch') changed = storage.switchBranch(character, action.branchId)
  else if (action.kind === 'edit') changed = storage.editMessage(character, target!.mid, action.content)
  else if (action.kind === 'delete') changed = storage.deleteMessage(character, target!.mid)
  else if (action.kind === 'truncate') changed = storage.truncateFrom(character, target!.mid)
  else if (action.kind !== 'continue') {
    if (action.kind === 'fork' || target !== messages.at(-1)) {
      changed = Boolean(storage.forkBranch(character, target!.mid))
      forked = changed
    }
    if (changed && action.kind === 'select-variant') changed = storage.selectVariant(character, target!.mid, action.variantId)
  }
  if (!changed) { options.notice('剧情操作未能保存，原内容已保留，请重试。', 'warning'); return }
  await flushProfileWrites()
  if (!current() || activeChar.value !== character) return
  if (action.kind === 'regenerate') await options.regenerateMessage(target!.mid)
  else if (action.kind === 'continue') await options.continueMessage(target!.mid)
  else options.notice(
    forked ? '已另开剧情，原剧情和后续对话已保留。'
      : action.kind === 'switch-branch' ? '已切换剧情。'
        : action.kind === 'edit' ? '消息已保存。'
          : action.kind === 'delete' ? '已删除该条消息。'
            : action.kind === 'truncate' ? '已回退到该条消息之前。'
              : '已切换回复备选。',
    'info',
  )
  if (action.kind === 'regenerate' || action.kind === 'continue' || forked) { await nextTick(); if (current()) options.scrollBottom() }
}

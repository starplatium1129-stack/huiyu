import { computed, onScopeDispose, ref, type Ref } from 'vue'
import { withChatTurn } from '@/utils/chatTurnOwnership'
import { canRegenerateChatMessage } from '@/utils/chatMessageStorage'
import { abortableTask } from '@/utils/abortableTask'
import type { ChatStoryAction } from '@/types/companionDrawing'
import type { useChatStorage } from './useChatStorage'

export interface StoryActionOptions {
  storage: ReturnType<typeof useChatStorage>
  activeChar: Ref<string>
  busy: Ref<boolean>
  chatReady: Readonly<Ref<boolean>>
  regenerateMessage: (mid: string) => Promise<void>
  stopVoice: () => void
  notice: (message: string, kind?: string) => void
  scrollBottom: () => void
}

/** Story edits share the inference writer, so a running turn keeps its context. */
export function useChatStoryActions(options: StoryActionOptions) {
  const { storage, activeChar, busy } = options
  const storyBusy = ref(false)
  const branchId = computed(() => storage.branchId(activeChar.value))
  const storyBranches = computed(() => storage.branches(activeChar.value))
  const canRegenerateMessage = (mid: string) => canRegenerateChatMessage(storage.messages(activeChar.value), mid)
  let alive = true
  let actionRevision = 0
  let actionController: AbortController | undefined
  onScopeDispose(() => { alive = false; cancelStoryAction() })
  function cancelStoryAction() { actionRevision++; actionController?.abort() }

  function handleStoryAction(action: ChatStoryAction, accepted?: (value: boolean) => boolean | void, expectedBranch = branchId.value, cancelled = () => false) {
    if (!alive || busy.value || storyBusy.value || !storage.canWrite()) { accepted?.(false); return }
    const character = activeChar.value
    const revision = actionRevision
    const controller = new AbortController()
    actionController = controller
    let loadingTimedOut = false
    const loadTimer = window.setTimeout(() => { loadingTimedOut = true; controller.abort() }, 15_000)
    storyBusy.value = true
    let acknowledged = false
    const acknowledge = (value: boolean) => { acknowledged = true; return accepted?.(value) }
    void withChatTurn(async () => {
      const { editChatStory } = await abortableTask(() => import('./chatStoryEditing'), controller.signal)
      window.clearTimeout(loadTimer)
      await editChatStory(options, action, { character, branch: expectedBranch, acknowledge,
        current: () => alive && !controller.signal.aborted && !cancelled() && revision === actionRevision })
    }, () => {
      acknowledge(false)
      if (alive) options.notice('另一个聊天窗口正在回复，请等回复结束后再切换剧情。', 'info')
    }).catch(() => {
      if (!acknowledged) acknowledge(false)
      if (alive && (!controller.signal.aborted || loadingTimedOut)) options.notice('剧情操作尚未保存，请保留当前窗口并重试。', 'warning')
    }).finally(() => { window.clearTimeout(loadTimer); actionController = undefined; storyBusy.value = false })
  }

  return { branchId, storyBranches, storyBusy, handleStoryAction, cancelStoryAction, canRegenerateMessage }
}

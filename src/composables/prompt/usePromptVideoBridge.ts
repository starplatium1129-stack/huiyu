import { ref, type ComputedRef, type Ref } from 'vue'
import type { DrawEngine } from '@/storage/settingsRepository'
import type { AnimaResultContext } from '@/types/anima'

export interface PromptVideoBridgeDeps {
  /** 当前显示结果 url（无值时无法转视频）。 */
  displayResultUrl: ComputedRef<string> | Ref<string>
  drawEngine: Ref<DrawEngine>
  /** 面板实时组装的提示词（SD 兜底源）。 */
  livePrompt: ComputedRef<string> | Ref<string>
  /** SD 最近一次实际提交的提示词。 */
  sdResultPrompt: Ref<string | undefined>
  /** Anima/Krea 会话状态（取其中的 result.blob 与 result.metadata.prompt）。 */
  animaState: Ref<{ result?: { blob?: Blob | null; metadata?: { prompt?: string }; resultContext?: AnimaResultContext | null } | null }>
  /** 场景描述文本（pb.story）。 */
  story: () => string
  /** 工作室场景 id（pb.sceneId）。 */
  sceneId: () => string | null
  subject: () => { kind: string; blueprintId?: string | null; characterId?: string; outfitId?: string }
  /** 当前显示结果的冻结上下文（F3）：Anima 读会话 state，SD 读视图 ref。 */
  resultContext: () => AnimaResultContext | null
  flash: (message: string) => void
}

/** Keep the pending count available without loading result-transfer tools on entry. */
export function usePromptVideoBridge(deps: PromptVideoBridgeDeps) {
  const shotsPending = ref(0)
  type Actions = ReturnType<typeof import('./promptVideoActions')['createPromptVideoActions']>
  let actions: Promise<Actions> | null = null
  function loadActions() {
    return actions ??= import('./promptVideoActions')
      .then(module => module.createPromptVideoActions(deps, shotsPending))
      .catch(error => { actions = null; throw error })
  }
  function lazy<K extends keyof Actions>(key: K) {
    return async (...args: Parameters<Actions[K]>) => {
      const action = (await loadActions())[key] as (...values: Parameters<Actions[K]>) => ReturnType<Actions[K]>
      return action(...args)
    }
  }
  async function refreshShotsPending() {
    try {
      const { readShotsCtx } = await import('@/composables/useVideoBridge')
      shotsPending.value = readShotsCtx().length
    } catch { /* The previous count remains usable when storage is unavailable. */ }
  }
  return {
    shotsPending, refreshShotsPending,
    videoTargetData: lazy('videoTargetData'), goToVideo: lazy('goToVideo'),
    addToShots: lazy('addToShots'), goToShots: lazy('goToShots'),
    handleHistoryToShots: lazy('handleHistoryToShots'), handleHistoryToShotsBatch: lazy('handleHistoryToShotsBatch'),
  }
}

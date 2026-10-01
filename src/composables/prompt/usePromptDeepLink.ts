import type { ArtworkRecord } from '@/types/artwork'
import { getCurrentInstance, getCurrentScope, onDeactivated, onScopeDispose, type Ref } from 'vue'
import type { usePromptBuilderStore, Scene } from '@/stores/promptBuilderStore'
import { isCharKey } from '@/composables/scene/directorOptions'
import { COLOR_MOODS } from '@/config/promptConstants'
import type { PopularCharacter, SceneBlueprint } from '@/utils/popularContent'
import type { useAnimaSession } from '@/composables/generation/useAnimaSession'

type PromptBuilderStore = ReturnType<typeof usePromptBuilderStore>
type AnimaSession = ReturnType<typeof useAnimaSession>

export interface PromptDeepLinkDeps {
  pb: PromptBuilderStore
  /** Host setter synchronizes engine dimensions through the existing supported-size policy. */
  sdSize: Ref<string>
  patchAnimaState: AnimaSession['patchState']
  /** 热门蓝图全量列表展开开关（预选蓝图卡片可能不在推荐 3 个里）。 */
  showAllBlueprints: Ref<boolean>
  selectPopularSource: (source: 'studio' | 'popular') => void
  selectBlueprint: (blueprint: SceneBlueprint) => void
  selectScene: (scene: Scene) => void
  applyRecommendedEngine: (character: PopularCharacter | null) => void
  applyHistory: (entry: ArtworkRecord, keepAsVariant?: boolean) => void | boolean | Promise<void | boolean>
}

/**
 * 绘图页深链参数应用（2026-08-22 自 PromptBuilderView 下沉）。
 *
 * ?scene / ?popular&blueprint / ?char / ?mood / ?scenario / ?regen|?remix|
 * ?variant / ?resume / ?quick 八类参数按「与宿主动作同一路径」回放（选角、
 * 选蓝图、应用历史等全部复用视图注入的动作，不另写一份状态写入）。
 * 调用时机归宿主：onMounted 首放 + watch(route.query) 按 deepLinkNeeded
 * 条件重放（bfcache / 组件复用时 onMounted 不重跑）。
 */
export function usePromptDeepLink(deps: PromptDeepLinkDeps) {
  const { pb } = deps
  let lastHistoryLink = ''
  let lastContextLink = ''
  let historyRequest = 0, disposed = false
  if (getCurrentScope()) onScopeDispose(() => { disposed = true; historyRequest += 1 })
  if (getCurrentInstance()) onDeactivated(() => { historyRequest += 1; lastHistoryLink = ''; lastContextLink = '' })
  function historyKey(q: Record<string, unknown>) {
    const mode = ['remix', 'regen', 'variant'].find(key => typeof q[key] === 'string')
    return mode ? mode + ':' + q[mode] : ''
  }
  function contextKey(q: Record<string, unknown>) {
    const fields = ['scenario', 'popular', 'blueprint', 'scene', 'char', 'mood', 'resume', 'quick']
      .flatMap(key => typeof q[key] === 'string' ? [[key, q[key]]] : [])
    return fields.length ? JSON.stringify(fields) : ''
  }

  async function applyDeepLink(q: Record<string, unknown>): Promise<boolean> {
    const request = ++historyRequest
    if (disposed || (!historyKey(q) && !contextKey(q))) return false
    const query = { ...q }
    const isCurrent = () => !disposed && request === historyRequest
    const { applyPromptDeepLink } = await import('./promptDeepLinkActions')
    if (!isCurrent()) return false
    const result = await applyPromptDeepLink(query, deps, isCurrent)
    if (!isCurrent()) return false
    if (result.historyApplied) lastHistoryLink = historyKey(query)
    if (result.handled && !historyKey(query)) lastContextLink = contextKey(query)
    return result.handled
  }

  /** URL 场景参数与当前选中不一致时才需要重放深链（避免覆盖用户手动编辑的状态）。 */
  function deepLinkNeeded(q: Record<string, unknown>): boolean {
    const history = historyKey(q)
    if (history) return history !== lastHistoryLink
    lastHistoryLink = ''
    const context = contextKey(q)
    if (!context) {
      lastContextLink = ''
      return false
    }
    if (typeof q.popular === 'string') {
      const blueprint = typeof q.blueprint === 'string' && q.blueprint ? q.blueprint : null
      if (pb.subject.kind !== 'popular'
        || pb.subject.characterId !== q.popular
        || pb.subject.blueprintId !== blueprint) return true
    }
    if (typeof q.scene === 'string' && pb.sceneId !== q.scene) return true
    if (isCharKey(q.char) && pb.char !== q.char) return true
    if (typeof q.mood === 'string' && COLOR_MOODS.some(m => m.id === q.mood) && pb.colorMood !== q.mood) return true
    return context !== lastContextLink
  }

  return { applyDeepLink, deepLinkNeeded }
}

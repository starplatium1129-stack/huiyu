import type { RouteLocationNormalizedLoaded } from 'vue-router'
import { confirmAction } from '@/composables/useConfirm'
import type { ArtworkRecord } from '@/types/artwork'
import { getCurrentInstance, getCurrentScope, onDeactivated, onScopeDispose, ref, watch, type Ref } from 'vue'
import type { usePromptBuilderStore, Scene } from '@/stores/promptBuilderStore'
import { isCharKey } from '@/composables/scene/directorOptions'
import { COLOR_MOODS } from '@/config/promptConstants'
import type { PopularCharacter, SceneBlueprint } from '@/utils/popularContent'
import type { useAnimaSession } from '@/composables/generation/useAnimaSession'
import type { usePromptDraftRecovery } from './usePromptDraftRecovery'

type PromptBuilderStore = ReturnType<typeof usePromptBuilderStore>
type AnimaSession = ReturnType<typeof useAnimaSession>

export interface PromptDeepLinkDeps {
  pb: PromptBuilderStore
  route: RouteLocationNormalizedLoaded
  getSettingsRevision: () => number
  draftRecovery: ReturnType<typeof usePromptDraftRecovery>
  generationBusy: Readonly<Ref<boolean>>
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
  const deepLinkError = ref(''), retryingDeepLink = ref(false)
  let failedQuery: Record<string, unknown> | null = null
  const entryKey = () => JSON.stringify([deps.route.path, deps.route.query])
  const clearFailure = () => { deepLinkError.value = ''; failedQuery = null }
  watch(entryKey, () => { historyRequest++; clearFailure() }, { flush: 'sync' })
  const hasFailedDeepLink = (query: Record<string, unknown>) => failedQuery !== null
    && JSON.stringify(query) === JSON.stringify(failedQuery)
  if (getCurrentScope()) onScopeDispose(() => { disposed = true; historyRequest += 1 })
  if (getCurrentInstance()) onDeactivated(() => { historyRequest += 1; lastHistoryLink = ''; lastContextLink = '' })
  function historyKey(q: Record<string, unknown>) {
    const mode = ['remix', 'regen', 'variant'].find(key => typeof q[key] === 'string')
    return mode ? mode + ':' + q[mode] : ''
  }
  function contextKey(q: Record<string, unknown>) {
    const fields = ['scenario', 'act', 'cast', 'outfit', 'popular', 'blueprint', 'scene', 'char', 'mood', 'resume', 'quick', 'companionDraft', 'draftOpen']
      .flatMap(key => typeof q[key] === 'string' ? [[key, q[key]]] : [])
    return fields.length ? JSON.stringify(fields) : ''
  }

  async function applyDeepLink(q: Record<string, unknown>, stillCurrent: () => boolean = () => true, inputsCurrent = () => true): Promise<boolean> {
    const request = ++historyRequest
    if (disposed || !stillCurrent() || (!historyKey(q) && !contextKey(q))) return false
    const query = { ...q }, entry = entryKey()
    const isCurrent = () => !disposed && request === historyRequest && entry === entryKey() && stillCurrent()
    const linkedCharacter = typeof query.cast === 'string' && typeof query.scenario === 'string' ? query.cast : query.popular
    if (typeof linkedCharacter === 'string') {
      try { await pb.loadPopularCharacter(linkedCharacter) }
      catch (error) {
        if (isCurrent()) {
          failedQuery = query
          deepLinkError.value = `链接中的角色场景未载入，未启动自动生成。${error instanceof Error ? error.message : '场景资料读取失败。'}`
        }
        return false
      }
    }
    if (!isCurrent()) return false
    const { applyPromptDeepLink } = await import('./promptDeepLinkActions')
    if (!isCurrent()) return false
    // A retry may wait on disk/network while the current draft remains editable.
    // Check before committing; its own synchronous scene writes are then allowed.
    if (!inputsCurrent()) {
      failedQuery = query
      deepLinkError.value = '读取期间当前输入已改变，链接场景尚未载入。请确认当前草稿后重试。'
      return false
    }
    try {
      const result = await applyPromptDeepLink(query, deps, isCurrent, inputsCurrent)
      if (!isCurrent()) return false
      clearFailure()
      if (result.historyApplied) lastHistoryLink = historyKey(query)
      if (result.handled && !historyKey(query)) lastContextLink = contextKey(query)
      return result.handled
    } catch (error) {
      if (isCurrent()) {
        failedQuery = query
        deepLinkError.value = error instanceof Error ? error.message : '作品暂时无法读取，请重试。'
      }
      return false
    }
  }

  async function retryDeepLink() {
    if (!failedQuery || retryingDeepLink.value || deps.generationBusy.value) return
    if (!deps.draftRecovery.initialized) { pb.flash('画室仍在恢复草稿，请稍后重试载入场景'); return }
    const query = failedQuery, entry = entryKey(), request = historyRequest
    const current = () => !disposed && entry === entryKey() && request === historyRequest && !deps.generationBusy.value
    let edited = false
    const revision = deps.getSettingsRevision()
    const stop = watch(() => JSON.stringify({ ...pb.snapshotDraft(), updatedAt: undefined, size: deps.sdSize.value }),
      () => { edited = true }, { flush: 'sync' })
    retryingDeepLink.value = true
    try {
      const confirmed = await confirmAction({ title: '重新载入链接中的场景？',
        message: '载入成功会替换当前角色、场景及相关创作设置。当前草稿中的修改可能被覆盖；不会自动生成图片。',
        confirmLabel: '重新载入场景', cancelLabel: '保留当前草稿' })
      if (!confirmed || !current()) return
      const inputsCurrent = () => !edited && revision === deps.getSettingsRevision()
      if (!inputsCurrent()) { deepLinkError.value = '当前输入已改变，链接场景尚未载入。请确认当前草稿后重试。'; return }
      // applyDeepLink takes ownership of the request; keep only entry/busy checks here.
      await applyDeepLink(query, () => entry === entryKey() && !deps.generationBusy.value, inputsCurrent)
    } finally { stop(); retryingDeepLink.value = false }
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

  return { applyDeepLink, deepLinkNeeded, deepLinkError, retryingDeepLink, retryDeepLink, hasFailedDeepLink }
}

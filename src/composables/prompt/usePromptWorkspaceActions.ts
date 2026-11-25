import { computed, onScopeDispose, type ComputedRef, type Ref } from 'vue'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import type { useAnimaSession } from '@/composables/generation/useAnimaSession'
import type { useDirectorEngine } from '@/composables/scene/useDirectorEngine'
import type { useDirectorPopular } from '@/composables/scene/useDirectorPopular'
import type { AnimaPixelUpscaler } from '@/config/animaHires'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { isActiveDrawEngine, type DrawEngine } from '@/storage/settingsRepository'
import type { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { copyText } from '@/utils/clipboard'
import type { HiresSource } from './promptGenerationActions'
import type { usePromptSdQueue } from './usePromptSdQueue'
import type { useResultRestoreOwner } from './useResultRestoreOwner'

type Store = ReturnType<typeof usePromptBuilderStore>
type Anima = ReturnType<typeof useAnimaSession>
type Engine = ReturnType<typeof useDirectorEngine>
type Popular = ReturnType<typeof useDirectorPopular>
type Queue = ReturnType<typeof usePromptSdQueue>
type Restore = ReturnType<typeof useResultRestoreOwner>

export interface PromptWorkspaceActionsDeps {
  pb: Store
  route: RouteLocationNormalizedLoaded
  restore: Restore
  drawEngine: Ref<DrawEngine>
  animaSession: Anima
  engine: Engine
  livePrompt: Readonly<Ref<string>>
  previewPromptView: Readonly<Ref<string>>
  generationBusy: ComputedRef<boolean>
  resultRevealUrl: Ref<string>
  hiresPreparing: Ref<boolean>
  compositionPreparing: Ref<boolean>
  cancelCompositionPreparation: Ref<(() => void) | null>
  cancelInpaintPreparation: () => boolean
  clearInpaintOriginal: () => void
  discardTemp: () => void
  applyManagedRoute: Popular['applyManagedRoute']
  sdQueue: Queue['sdQueue']
  sdErrorReport: Queue['sdErrorReport']
  restoredCount: number
}

/** Owns prompt workspace user actions: generate, upscale, cancel, stash/seed reuse, interrogate & copy. */
export function usePromptWorkspaceActions(deps: PromptWorkspaceActionsDeps) {
  const {
    pb, route, restore, drawEngine, animaSession, engine,
    livePrompt, previewPromptView, generationBusy, resultRevealUrl,
    hiresPreparing, compositionPreparing, cancelCompositionPreparation,
    cancelInpaintPreparation, clearInpaintOriginal, discardTemp,
    applyManagedRoute, sdQueue, sdErrorReport, restoredCount,
  } = deps

  let hiresPreparation: AbortController | null = null
  function cancelHiresPreparation() {
    hiresPreparation?.abort()
    hiresPreparation = null
    hiresPreparing.value = false
  }
  onScopeDispose(cancelHiresPreparation, true)

  async function handleInterrogateResult(result: unknown, requestCurrent: () => boolean) {
    const current = () => !restore.isDisposed() && restore.isInterrogateActive() && requestCurrent()
    if (!current()) return
    const [{ applyInterrogateResult }] = await Promise.all([
      import('@/composables/prompt/applyInterrogateResult'),
      pb.loadPopularCatalog(),
    ])
    if (current()) await applyInterrogateResult(pb, result, current, route.query.engine === 'moss')
  }

  function handleInterrogateError(message: string) {
    pb.flash('反推失败：' + message)
  }

  /** 分类恢复：对应旧版 runSDRecovery */
  async function copyPrompt() {
    const copied = await copyText(previewPromptView.value)
    pb.flash(copied ? 'Prompt 已复制' : '复制失败，请手动选取')
    return copied
  }

  function cancelGeneration() {
    if (hiresPreparing.value) { cancelHiresPreparation(); return }
    if (compositionPreparing.value) cancelCompositionPreparation.value?.()
    else if (!cancelInpaintPreparation()) engine.cancelGeneration()
  }

  /**
   * 画师选满后再点（2026-08-30 UX 审计 P1）：面板内已有就地提示，这里补一条
   * toast——画师网格在折叠面板里，提示有可能被滚出视野。
   */
  function onArtistLimitReached(max: number) {
    pb.flash(`最多同时选 ${max} 位画师，先取消一位再选`)
  }

  /**
   * 队列为什么暂停（2026-08-30 UX 审计 P1）。
   *
   * 队列面板原本只写「已暂停」——用户不知道是任务失败了、还是自己按的暂停。
   * 失败时 sdErrorReport 里已有分类结论（中文标题 + 建议），直接引过来；快照
   * 恢复导致的暂停单独说明来源。手动暂停不需要解释，返回空串。
   */
  const queuePausedReason = computed(() => {
    if (!sdQueue.paused.value) return ''
    if (sdErrorReport.value) return `${sdErrorReport.value.title}：${sdErrorReport.value.message}`
    if (restoredCount > 0) return '这些任务来自上次离开时的队列，确认参数后点「继续」'
    return ''
  })

  /** Unknown requests always recover the frozen attempt, including tool callers. */
  function retryAnima() {
    if (generationBusy.value) return
    void animaSession.generate()
  }

  // ── F2：上一张未入册成片的找回 / 显式丢弃 ─────────────────────────────
  /** 失败/取消后画布旁可「找回上一张」（Anima/Krea 暂存；SD 旧图从未离开画布）。 */
  const hasStashedResult = computed(() => Boolean(animaSession.stashedResult.value))
  function onRestoreStashed() {
    if (animaSession.restoreStashedResult()) {
      resultRevealUrl.value = ''
      pb.flash('已恢复上一张未入册的成片，可存入作品册或继续新作')
    }
  }

  /** 「清除」是显式丢弃：临时缓冲同步清掉，避免下次进页又被找回。 */
  function onClearResult() {
    clearInpaintOriginal()
    resultRevealUrl.value = ''
    discardTemp()
    animaSession.discardStashedResult()
    engine.clearDisplayedResult()
  }

  function reuseLastSeed() {
    const seed = engine.displayResultSeed.value ?? pb.lastSeed
    if (seed == null || seed < 0) {
      pb.flash('还没有可复用的 seed')
      return
    }
    pb.sdParams.seed = seed
    pb.sdParams.seedLock = true
    pb.flash(`已锁定 seed ${seed}`)
  }

  async function callGenerate(): Promise<void> {
    if (animaSession.hasPending.value) { await animaSession.recover(); return }
    const activeEngine = drawEngine.value
    if (!isActiveDrawEngine(activeEngine)) {
      pb.flash('历史 SD 配方仅供查看；请选择 Anima 或 Krea 2 开始新创作')
      return
    }
    const subject = pb.subject
    if (pb.isUnbound) {
      try { await pb.loadPopularCatalog() }
      catch { pb.flash('角色词条暂时无法读取，请重试。'); return }
      if (restore.isDisposed() || !pb.isUnbound || pb.subject !== subject || activeEngine !== drawEngine.value) return
    }
    const { callGenerateAction } = await import('./promptGenerationActions')
    await callGenerateAction({ pb, applyManagedRoute, livePrompt, generationBusy, generateAnima: animaSession.generate })
  }

  async function upscaleCurrentResult(method: AnimaPixelUpscaler): Promise<void> {
    if (generationBusy.value || restore.isDisposed() || drawEngine.value !== 'anima') return
    if (animaSession.hasPending.value) { pb.flash('请先恢复或取消上一张任务'); return }
    const result = animaSession.state.value.result
    if (!result || engine.displayResultUrl.value !== result.url) return
    const source: HiresSource = {
      result,
      anima: animaSession.resultSubmission(),
      context: animaSession.state.value.resultContext ?? null,
    }
    const preparation = new AbortController()
    const identity = runtimeResourceIdentity()
    const current = () => !preparation.signal.aborted && !restore.isDisposed() && identity === runtimeResourceIdentity()
      && drawEngine.value === 'anima' && engine.displayResultUrl.value === result.url
    hiresPreparation = preparation
    hiresPreparing.value = true
    try {
      const { prepareResultUpscale } = await import('./promptGenerationActions')
      if (!current()) return
      const submission = await prepareResultUpscale(source, method, preparation.signal)
      if (!current()) return
      cancelHiresPreparation()
      await animaSession.generate({}, submission)
    } catch (error) {
      if (current()) pb.flash(error instanceof Error ? error.message : '成片放大失败')
    } finally {
      if (hiresPreparation === preparation) cancelHiresPreparation()
    }
  }

  return {
    handleInterrogateResult,
    handleInterrogateError,
    copyPrompt,
    cancelGeneration,
    onArtistLimitReached,
    queuePausedReason,
    retryAnima,
    hasStashedResult,
    onRestoreStashed,
    onClearResult,
    reuseLastSeed,
    callGenerate,
    upscaleCurrentResult,
  }
}

import { ref, type ComputedRef, type Ref } from 'vue'
import type { DrawEngine } from '@/storage/settingsRepository'
import type { AnimaResultContext } from '@/types/anima'
import type { ArtworkRecord } from '@/types/artwork'
import type { VideoBridgeTarget } from '@/stores/videoStore'
import { runtimeFetch } from '@/platform/runtimeUrl'

export type PromptVideoSnapshot = Readonly<Omit<VideoBridgeTarget, 'flash' | 'push'>>
export type HistoryVideoSnapshot = Readonly<Pick<ArtworkRecord,
  'image_id' | 'prompt' | 'story' | 'blueprintId' | 'characterId' | 'outfitId' | 'scene'>>

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
      .then(module => module.createPromptVideoActions(deps.flash, shotsPending))
      .catch(error => { actions = null; throw error })
  }
  async function captureResult(): Promise<PromptVideoSnapshot | null> {
    const displayUrl = deps.displayResultUrl.value, engine = deps.drawEngine.value
    if (!displayUrl) { deps.flash('暂无可转视频的成片'); return null }
    const result = engine === 'sd' ? null : deps.animaState.value.result
    if (engine !== 'sd' && !result) { deps.flash('成片数据已失效，请重新生成'); return null }
    const subject = deps.subject(), context = deps.resultContext()
    // Flatten the clicked result before any import or storage await. Only
    // immutable strings and Blob cross the boundary; mutable form/context do not.
    const snapshot: PromptVideoSnapshot = {
      displayUrl, animaBlob: result?.blob ?? null,
      prompt: (engine === 'sd' ? deps.sdResultPrompt.value : result?.metadata?.prompt) || deps.livePrompt.value || '',
      story: context?.story ?? (deps.story() || ''),
      blueprintId: context ? (context.blueprintId ?? null)
        : (subject.kind === 'popular' ? (subject.blueprintId ?? null) : deps.sceneId()),
      characterId: context ? (context.characterId ?? '') : (subject.kind === 'popular' ? subject.characterId ?? '' : ''),
      outfitId: context ? (context.outfitId ?? null) : (subject.kind === 'popular' ? (subject.outfitId ?? null) : null),
      sceneId: context ? (context.sceneId ?? null) : deps.sceneId(),
    }
    if (engine !== 'sd') return snapshot
    // Legacy SD owns only a URL. Start the already-requested source read before
    // loading actions, so clearing/replacing the canvas cannot revoke its bytes.
    try {
      const response = await runtimeFetch(displayUrl, { cache: 'no-store', signal: AbortSignal.timeout(30_000) })
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) {
        deps.flash('成片响应无效，请重新生成'); return null
      }
      const blob = await response.blob()
      if (!blob.size) { deps.flash('成片数据已失效，请重新生成'); return null }
      return { ...snapshot, animaBlob: blob }
    } catch (error) {
      deps.flash('成片处理失败')
      console.warn(error)
      return null
    }
  }
  function captureHistory(entry: ArtworkRecord): HistoryVideoSnapshot {
    return { image_id: entry.image_id, prompt: entry.prompt, story: entry.story,
      blueprintId: entry.blueprintId, characterId: entry.characterId, outfitId: entry.outfitId, scene: entry.scene }
  }
  async function goToVideo(push: (path: string) => Promise<unknown> | void) {
    const snapshot = await captureResult()
    if (snapshot) await (await loadActions()).goToVideo(snapshot, push)
  }
  async function addToShots() {
    const snapshot = await captureResult()
    if (snapshot) await (await loadActions()).addToShots(snapshot)
  }
  async function goToShots(push: (path: string) => Promise<unknown> | void) {
    await (await loadActions()).goToShots(push)
  }
  async function handleHistoryToShots(entry: ArtworkRecord) {
    const snapshot = captureHistory(entry)
    await (await loadActions()).handleHistoryToShots(snapshot)
  }
  async function handleHistoryToShotsBatch(entries: ArtworkRecord[]) {
    const snapshots = entries.map(captureHistory)
    await (await loadActions()).handleHistoryToShotsBatch(snapshots)
  }
  async function refreshShotsPending() {
    try {
      const { readShotsCtx } = await import('@/composables/useVideoBridge')
      shotsPending.value = readShotsCtx().length
    } catch { /* The previous count remains usable when storage is unavailable. */ }
  }
  return {
    shotsPending, refreshShotsPending,
    goToVideo, addToShots, goToShots,
    handleHistoryToShots, handleHistoryToShotsBatch,
  }
}

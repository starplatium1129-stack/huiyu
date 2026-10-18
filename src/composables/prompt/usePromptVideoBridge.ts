import { ref, type ComputedRef, type Ref } from 'vue'
import type { DrawEngine } from '@/storage/settingsRepository'
import type { AnimaResultContext } from '@/types/anima'
import type { ArtworkRecord } from '@/types/artwork'
import type { ResultRestoreOwner } from '@/composables/generation/animaSessionContract'
import type { VideoTransferImage, VideoTransferOwner } from '@/composables/useVideoBridge'
import { artworkRepository } from '@/storage/artworkRepository'
import { tempResultOwner } from '@/utils/tempResult'
import { runtimeFetch } from '@/platform/runtimeUrl'

export type PromptVideoSnapshot = VideoTransferImage
export type HistoryVideoSnapshot = Readonly<Pick<ArtworkRecord,
  'image_id' | 'prompt' | 'story' | 'blueprintId' | 'characterId' | 'outfitId' | 'scene'>>

export interface PromptVideoBridgeDeps {
  displayResultUrl: ComputedRef<string> | Ref<string>
  drawEngine: Ref<DrawEngine>
  livePrompt: ComputedRef<string> | Ref<string>
  sdResultPrompt: Ref<string | undefined>
  animaState: Ref<{ result?: { blob?: Blob | null; metadata?: { prompt?: string } } | null }>
  story: () => string
  sceneId: () => string | null
  subject: () => { kind: string; blueprintId?: string | null; characterId?: string; outfitId?: string }
  resultContext: () => AnimaResultContext | null
  getRestoreOwner: () => ResultRestoreOwner
  flash: (message: string) => void
}

/** Capture admission before any media read or lazy import. The existing visit
 * owner invalidates on route/session changes, including same-field reconnects. */
export function usePromptVideoBridge(deps: PromptVideoBridgeDeps) {
  const shotsPending = ref(0), transferBusy = ref(false)
  type Actions = ReturnType<typeof import('./promptVideoActions')['createPromptVideoActions']>
  let actions: Promise<Actions> | null = null
  function loadActions() {
    return actions ??= import('./promptVideoActions')
      .then(module => module.createPromptVideoActions(deps.flash, shotsPending))
      .catch(error => { actions = null; throw error })
  }
  async function runTransfer(work: (owner: VideoTransferOwner, actions: Promise<Actions>) => Promise<void>) {
    if (transferBusy.value) return
    transferBusy.value = true
    const controller = new AbortController()
    let owner: VideoTransferOwner | undefined
    try {
      const visit = deps.getRestoreOwner(), repository = artworkRepository
      const signal = AbortSignal.any([visit.signal, controller.signal])
      owner = { repository, logicalOwner: tempResultOwner(), signal,
        current: () => !signal.aborted && visit.current() && repository === artworkRepository }
      if (!owner.current()) return
      await work(owner, loadActions())
    } catch (error) {
      if (!owner || owner.current()) {
        deps.flash(error instanceof Error ? error.message : '图片交接失败，原图片已保留')
        console.warn(error)
      }
    } finally { controller.abort(); transferBusy.value = false }
  }
  async function captureResult(owner: VideoTransferOwner): Promise<PromptVideoSnapshot | null> {
    const displayUrl = deps.displayResultUrl.value, engine = deps.drawEngine.value
    if (!displayUrl) { deps.flash('暂无可转视频的成片'); return null }
    const result = engine === 'sd' ? null : deps.animaState.value.result
    if (engine !== 'sd' && !result) { deps.flash('成片暂不可读取，请恢复原图片后重试'); return null }
    const subject = deps.subject(), context = deps.resultContext()
    const snapshot = {
      prompt: (engine === 'sd' ? deps.sdResultPrompt.value : result?.metadata?.prompt) || deps.livePrompt.value || '',
      story: context?.story ?? (deps.story() || ''),
      blueprintId: context ? (context.blueprintId ?? null)
        : (subject.kind === 'popular' ? (subject.blueprintId ?? null) : deps.sceneId()),
      characterId: context ? (context.characterId ?? '') : (subject.kind === 'popular' ? subject.characterId ?? '' : ''),
      outfitId: context ? (context.outfitId ?? null) : (subject.kind === 'popular' ? (subject.outfitId ?? null) : null),
      sceneId: context ? (context.sceneId ?? null) : deps.sceneId(),
    }
    if (result?.blob) return { ...snapshot, blob: result.blob }
    // Start URL-only reads now; a later canvas clear can revoke its Blob URL.
    try {
      const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(30_000)])
      const response = await runtimeFetch(displayUrl, { cache: 'no-store', signal })
      if (!owner.current()) return null
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('成片响应暂不可读取')
      const blob = await response.blob()
      if (!owner.current()) return null
      if (!blob.size) throw new Error('成片数据暂不可读取')
      return { ...snapshot, blob }
    } catch (error) {
      if (owner.current()) { deps.flash('成片处理失败，请恢复原图片后重试'); console.warn(error) }
      return null
    }
  }
  function captureHistory(entry: ArtworkRecord): HistoryVideoSnapshot {
    return { image_id: entry.image_id, prompt: entry.prompt, story: entry.story,
      blueprintId: entry.blueprintId, characterId: entry.characterId, outfitId: entry.outfitId, scene: entry.scene }
  }
  function goToVideo(push: (path: string) => Promise<unknown> | void) {
    return runTransfer(async (owner, loading) => {
      const reading = captureResult(owner), tools = await loading
      if (!owner.current() || await tools.resumePending(owner)) return
      const snapshot = await reading
      if (snapshot && owner.current()) await tools.goToVideo(snapshot, push, owner)
    })
  }
  function addToShots() {
    return runTransfer(async (owner, loading) => {
      const reading = captureResult(owner), tools = await loading
      if (!owner.current() || await tools.resumePending(owner)) return
      const snapshot = await reading
      if (snapshot && owner.current()) await tools.addToShots(snapshot, owner)
    })
  }
  function goToShots(push: (path: string) => Promise<unknown> | void) {
    return runTransfer(async (owner, loading) => { await (await loading).goToShots(push, owner) })
  }
  function handleHistoryToShots(entry: ArtworkRecord) {
    return runTransfer(async (owner, loading) => {
      const snapshot = captureHistory(entry), tools = await loading
      if (owner.current() && !await tools.resumePending(owner)) await tools.handleHistoryToShots(snapshot, owner)
    })
  }
  function handleHistoryToShotsBatch(entries: ArtworkRecord[]) {
    return runTransfer(async (owner, loading) => {
      const snapshots = entries.map(captureHistory), tools = await loading
      if (owner.current() && !await tools.resumePending(owner)) await tools.handleHistoryToShotsBatch(snapshots, owner)
    })
  }
  async function refreshShotsPending() {
    const owner = deps.getRestoreOwner()
    try {
      const { readShotsCount } = await import('@/composables/useVideoBridge')
      if (owner.current()) shotsPending.value = readShotsCount()
    } catch { /* Preserve the last count when storage is unavailable. */ }
  }
  return { shotsPending, transferBusy, refreshShotsPending, goToVideo, addToShots, goToShots, handleHistoryToShots, handleHistoryToShotsBatch }
}

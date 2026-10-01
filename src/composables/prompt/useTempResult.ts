import { runtimeFetch } from '../../platform/runtimeUrl.ts'
import { withArtworkStaging } from '../../storage/artworkSession.ts'
import { computed, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { usePromptBuilderStore, HistoryEntry } from '../../stores/promptBuilderStore.ts'
import type { DrawEngine } from '../../storage/settingsRepository.ts'
import type { AnimaResult, AnimaResultContext } from '../../types/anima.ts'
import type { useAnimaSession } from '../generation/useAnimaSession.ts'
import type { useSDGenerate } from '../generation/useSDGenerate.ts'
import type { SDQueueJob } from '../generation/useSDQueue.ts'
import { hasRuntimeTasks, isRuntimeTaskId } from '../../api/runtimeTaskAuthority.ts'
import { artworkRepository } from '../../storage/artworkRepository.ts'
import {
  clearTempResult,
  readTempResult,
  writeTempResult,
  type TempResultRecord,
} from '../../utils/tempResult.ts'

type PromptBuilderStore = ReturnType<typeof usePromptBuilderStore>
type AnimaSession = ReturnType<typeof useAnimaSession>
let tempMutation = 0

export interface TempResultDeps {
  pb: PromptBuilderStore
  sd: ReturnType<typeof useSDGenerate>
  drawEngine: Ref<DrawEngine>
  animaState: AnimaSession['state']
  patchAnimaState: AnimaSession['patchState']
  displayResultUrl: ComputedRef<string>
  displayResultSeed: ComputedRef<number | null>
  livePrompt: ComputedRef<string>
  negativePrompt: ComputedRef<string>
  historyGenerationFields: () => Partial<HistoryEntry>
  commitJobResult: (job: Omit<SDQueueJob, 'id'>, url: string) => Promise<HistoryEntry | null>
  /** F3 冻结上下文（SD 路径由 usePromptSdQueue 写入；Anima 读会话 state）。 */
  resultContext: Ref<AnimaResultContext | null>
  autoSaveToGallery: Ref<boolean>
  setDrawEngine: (engine: DrawEngine) => void
}

/**
 * 绘图页「未入册成片」临时缓冲（2026-09-06 体验报告 F2）。
 *
 * 生命周期契约：
 * - 直出成功即落 IndexedDB + sessionStorage 指针（容量恒定最近一张）；
 * - 入册成功（自动或手动「保存快照」）→ 清除；用户点「清除」→ 清除；
 * - 离页/刷新后回页 → restoreTempResult 重建舞台结果（Anima 含完整元数据）。
 *
 * 同时收编「舞台结果 ↔ 作品册条目」锚点（displayedResultHistoryId）与手动
 * 入册动作（原 saveHistory），让「这张图入没入册」有单一事实来源。
 */
export function useTempResult(deps: TempResultDeps) {
  const { pb, sd } = deps

  /** 舞台当前结果对应的作品册条目 id（null=尚未入册；原 P1-14 inpaint 锚点）。 */
  const displayedResultHistoryId = ref<string | number | null>(null)
  const savingResult = ref(false)
  let resultRevision = 0
  let disposed = false
  watch(deps.displayResultUrl, () => {
    resultRevision += 1
    displayedResultHistoryId.value = null
  }, { flush: 'sync' })
  onScopeDispose(() => { disposed = true; resultRevision += 1 }, true)
  function ownsResult(url: string) {
    const revision = resultRevision
    return () => !disposed && revision === resultRevision && deps.displayResultUrl.value === url
  }
  const storedResultUrl = ref('')
  const resultTemporary = computed(() => Boolean(deps.displayResultUrl.value && storedResultUrl.value === deps.displayResultUrl.value))

  /** 舞台徽章：有结果时如实标注入册状态（未入册的其实已在临时缓冲）。 */
  const resultArchived = computed<boolean | null>(() =>
    deps.displayResultUrl.value ? displayedResultHistoryId.value !== null : null)

  /** 替换式写入：先读旧记录，新记录落稳后回收旧 blob（不炸主链路）。 */
  async function captureTemp(partial: Omit<TempResultRecord, 'imageId' | 'savedAt'>, blob: Blob, url = deps.displayResultUrl.value, current = ownsResult(url)) {
    if (hasRuntimeTasks() && (isRuntimeTaskId(partial.animaMetadata?.id || '') || (sd.resultUrl.value === url && sd.resultTaskId?.value))) {
      if (current()) storedResultUrl.value = url
      return
    }
    return withArtworkStaging(async () => {
      if (!current()) return
      const mutation = ++tempMutation
      try {
        const imageId = await artworkRepository.putImage(blob)
        if (mutation !== tempMutation || !current()) { void artworkRepository.deleteImage(imageId).catch(() => {}); return }
        const previous = readTempResult()
        if (!writeTempResult({ ...partial, imageId, savedAt: Date.now() })) {
          void artworkRepository.deleteImage(imageId).catch(() => {})
          pb.flash('临时成片写入失败（存储空间不足）：可尝试「存入作品册」或下载原图')
          return
        }
        storedResultUrl.value = url
        if (previous && previous.imageId !== imageId) void artworkRepository.deleteImage(previous.imageId).catch(() => {})
      } catch (error) {
        console.warn('[temp-result] capture failed', error)
        if (current()) pb.flash('临时成片保存失败：请在离开前存入作品册或下载原图')
      }
    })
  }

  /** 入册成功 → 临时记录使命完成（作品册条目自带 blob 副本，回收暂存图）。 */
  function releaseTemp() {
    tempMutation += 1
    storedResultUrl.value = ''
    const record = readTempResult()
    clearTempResult()
    if (record) void artworkRepository.deleteImage(record.imageId).catch(() => {})
  }

  /** 舞台当前结果的 F3 冻结上下文（Anima 在会话 state，SD 在 resultContext ref）。 */
  function currentContext(): AnimaResultContext | null {
    return deps.drawEngine.value !== 'sd'
      ? (deps.animaState.value.resultContext ?? null)
      : deps.resultContext.value
  }

  /** Anima/Krea 直出成功：按偏好入册或落临时缓冲（原 onAnimaResult 内联块下沉）。 */
  const freeze = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
  async function handleAnimaResult(result: AnimaResult) {
    const current = ownsResult(result.url)
    const autoSave = deps.autoSaveToGallery.value
    const runtimeTaskId = hasRuntimeTasks() && isRuntimeTaskId(result.metadata.id) ? result.metadata.id : undefined
    if (!autoSave) {
      if (current()) displayedResultHistoryId.value = null
      if (runtimeTaskId) { storedResultUrl.value = result.url; return }
    }
    const input = { result: { ...result, metadata: freeze(result.metadata) }, current,
      context: freeze(deps.animaState.value.resultContext ?? null), autoSave, runtimeTaskId,
      history: autoSave ? freeze(deps.historyGenerationFields()) : {},
      story: autoSave ? String(pb.story || '').trim() : '', scene: autoSave ? pb.sceneId : null }
    const { handleAnimaResultAction } = await import('./tempResultActions')
    await handleAnimaResultAction(input, { pb, displayedResultHistoryId, captureTemp, releaseTemp })
  }

  async function handleSdResult(job: Omit<SDQueueJob, 'id'>, url: string) {
    const current = ownsResult(url)
    const autoSave = deps.autoSaveToGallery.value
    if (!autoSave) {
      if (current()) displayedResultHistoryId.value = null
      if (hasRuntimeTasks() && sd.resultTaskId?.value) { storedResultUrl.value = url; return }
    }
    const input = { job: freeze(job), url, current, seed: sd.resultSeed.value,
      context: freeze(deps.resultContext.value), autoSave, save: null as Promise<HistoryEntry | null> | null }
    // The original job reference owns the runner's already-frozen WeakMap facts.
    // Capture its archive promise before loading completion handling; observing
    // rejection here leaves the original promise available to the action catch.
    if (autoSave) {
      try { input.save = deps.commitJobResult(job, url) }
      catch (error) { input.save = Promise.reject(error) }
      void input.save.catch(() => {})
    }
    const { handleSdResultAction } = await import('./tempResultActions')
    await handleSdResultAction(input, { pb, displayedResultHistoryId, captureTemp, releaseTemp })
  }

  /** 手动「保存快照」（原 saveHistory 下沉）：入册成功即释放临时缓冲。 */
  async function saveCurrentResult() {
    if (savingResult.value || displayedResultHistoryId.value !== null) return
    savingResult.value = true
    try {
      const url = deps.displayResultUrl.value
      if (!url) { pb.flash('暂无可保存的成片'); return }
      const current = ownsResult(url)
      const frozen = currentContext()
      const snapshot = JSON.parse(JSON.stringify({
        taskId: hasRuntimeTasks() ? deps.drawEngine.value === 'sd' ? sd.resultTaskId?.value : isRuntimeTaskId(deps.animaState.value.result?.metadata.id || '') ? deps.animaState.value.result?.metadata.id : undefined : undefined,
        context: frozen, seed: deps.displayResultSeed.value ?? undefined,
        ...deps.historyGenerationFields(), story: frozen?.story,
        scene: frozen ? (frozen.sceneId ?? null) : undefined,
        parentId: frozen?.parentId,
      })) as Partial<HistoryEntry>
      const resultPrompt = sd.resultPrompt.value
      let blob: Blob
      let prompt = deps.livePrompt.value
      let negative = deps.negativePrompt.value
      if (deps.drawEngine.value !== 'sd') {
        const result = deps.animaState.value.result
        if (!result) { pb.flash('成片数据已失效，请重新生成'); return }
        blob = result.blob
        prompt = result.metadata.prompt
        negative = result.metadata.negative
      } else {
        const response = await runtimeFetch(url, { cache: 'no-store' })
        const contentType = response.headers.get('content-type') || ''
        if (!response.ok || !contentType.startsWith('image/')) {
          pb.flash('成片响应无效，请重新生成')
          return
        }
        blob = await response.blob()
        // 按图取词：SD 结果记录的是提交时实际使用的提示词，面板后续修改不漂移。
        prompt = resultPrompt || frozen?.history?.prompt || prompt
        negative = frozen?.history?.negative ?? negative
      }
      if (!blob.size) { pb.flash('成片数据已失效，请重新生成'); return }
      const entry = await pb.commitHistoryEntry({
        ...snapshot,
        blob,
        negative,
        prompt,
      })
      if (entry) {
        // A completed save belongs to the clicked image, not a newer result on the canvas.
        if (current()) {
          displayedResultHistoryId.value = entry.id
          releaseTemp()
        }
        pb.flash('画面已存入本地作品册')
      } else pb.flash('入册未成功，画面仍在画布上，请重试或下载原图')
    } catch (e) { pb.flash('入册未成功，画面仍在画布上，请重试或下载原图'); console.warn(e) }
    finally { savingResult.value = false }
  }

  /**
   * 回页找回上次未入册的成片（F1/F2 交汇）。只在画布为空时调用；
   * 返回是否发生了恢复（调用方据此提示）。
   */
  async function restoreTempResult(): Promise<boolean> {
    if (deps.displayResultUrl.value) return false
    const current = ownsResult('')
    const { restoreUnarchivedResult } = await import('./tempResultRestore')
    return restoreUnarchivedResult(deps, storedResultUrl, current)
  }

  /** 用户显式「清除」舞台结果：临时缓冲一并丢弃（显式丢弃优于一切恢复）。 */
  function discardTemp() {
    const taskId = hasRuntimeTasks() ? deps.drawEngine.value === 'sd' ? sd.resultTaskId?.value : deps.animaState.value.result?.metadata.id : undefined
    resultRevision += 1
    releaseTemp()
    if (taskId && isRuntimeTaskId(taskId)) void import('@/api/runtimeTasks').then(api => api.markRuntimeTask(taskId, 'discarded'))
      .catch(() => pb.flash('清除尚未同步到收件箱，请在任务中心核对'))
  }

  return {
    displayedResultHistoryId,
    resultArchived,
    savingResult,
    resultTemporary,
    handleAnimaResult,
    handleSdResult,
    saveCurrentResult,
    restoreTempResult,
    discardTemp,
  }
}

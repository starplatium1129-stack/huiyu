import { withArtworkStaging } from '@/storage/artworkSession'
import { computed, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { usePromptBuilderStore, HistoryEntry } from '@/stores/promptBuilderStore'
import type { DrawEngine } from '@/storage/settingsRepository'
import type { AnimaResult, AnimaResultContext } from '@/types/anima'
import type { useAnimaSession } from '@/composables/generation/useAnimaSession'
import type { useSDGenerate } from '@/composables/generation/useSDGenerate'
import type { SDQueueJob } from '@/composables/generation/useSDQueue'
import { imgDelete, imgGet, imgPut } from '@/composables/useImageStore'
import {
  clearTempResult,
  readTempResult,
  writeTempResult,
  type TempResultRecord,
} from '@/utils/tempResult'

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
  const displayedResultHistoryId = ref<number | null>(null)
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
    return withArtworkStaging(async () => {
      if (!current()) return
      const mutation = ++tempMutation
      try {
        const imageId = await imgPut(blob)
        if (mutation !== tempMutation || !current()) { void imgDelete(imageId).catch(() => {}); return }
        const previous = readTempResult()
        if (!writeTempResult({ ...partial, imageId, savedAt: Date.now() })) {
          void imgDelete(imageId).catch(() => {})
          pb.flash('临时成片写入失败（存储空间不足）：可尝试「存入作品册」或下载原图')
          return
        }
        storedResultUrl.value = url
        if (previous && previous.imageId !== imageId) void imgDelete(previous.imageId).catch(() => {})
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
    if (record) void imgDelete(record.imageId).catch(() => {})
  }

  /** 舞台当前结果的 F3 冻结上下文（Anima 在会话 state，SD 在 resultContext ref）。 */
  function currentContext(): AnimaResultContext | null {
    return deps.drawEngine.value !== 'sd'
      ? (deps.animaState.value.resultContext ?? null)
      : deps.resultContext.value
  }

  /** Anima/Krea 直出成功：按偏好入册或落临时缓冲（原 onAnimaResult 内联块下沉）。 */
  async function handleAnimaResult(result: AnimaResult, inpaintSourceHistoryId: number | null) {
    const current = ownsResult(result.url)
    const frozen = deps.animaState.value.resultContext ?? null
    if (!deps.autoSaveToGallery.value) {
      if (current()) displayedResultHistoryId.value = null
      await captureTemp({
        engine: result.metadata.engine,
        prompt: result.metadata.prompt,
        negative: result.metadata.negative,
        seed: result.metadata.seed,
        size: `${result.metadata.width}x${result.metadata.height}`,
        animaMetadata: result.metadata,
        context: frozen,
      }, result.blob, result.url, current)
      return
    }
    try {
      if (!result.blob.size) throw new Error('成片数据为空')
      // initImage 非空即 inpaint 重绘：parent_id 回指来源条目，作品册对比才有
      // 「重绘前 vs 重绘后」的真实语义（P1-14）。
      const isInpaint = Boolean(result.metadata.initImage)
      const saved = await pb.commitHistoryEntry({
        context: frozen,
        blob: result.blob,
        seed: result.metadata.seed,
        negative: result.metadata.negative ?? '',
        prompt: result.metadata.prompt,
        ...deps.historyGenerationFields(),
        // F3：入册字段跟随出图时的冻结上下文，不随生成期间的表单改动漂移。
        story: frozen?.story ?? String(pb.story || '').trim(),
        scene: frozen ? (frozen.sceneId ?? null) : pb.sceneId,
        hiresFix: result.metadata.hiresFix === true,
        hiresScale: typeof result.metadata.hiresScale === 'number' ? result.metadata.hiresScale : undefined,
        hiresDenoise: typeof result.metadata.hiresDenoise === 'number' ? result.metadata.hiresDenoise : undefined,
        parentId: isInpaint ? (inpaintSourceHistoryId ?? undefined) : undefined,
      })
      if (!saved) throw new Error('作品册写入失败')
      if (current()) {
        displayedResultHistoryId.value = saved.id
        releaseTemp()
        pb.flash('已自动存入作品册')
      }
    } catch (e) {
      console.warn('anima direct autosave failed', e)
      if (!current()) return
      pb.flash('自动入册失败：成片已保留在临时缓冲，可手动点「存入作品册」')
      await captureTemp({
        engine: result.metadata.engine,
        prompt: result.metadata.prompt,
        negative: result.metadata.negative,
        seed: result.metadata.seed,
        size: `${result.metadata.width}x${result.metadata.height}`,
        animaMetadata: result.metadata,
        context: frozen,
      }, result.blob, result.url, current)
    }
  }

  /** SD 直出成功：按偏好入册或落临时缓冲（原 callGenerate 尾段下沉）。 */
  async function handleSdResult(job: Omit<SDQueueJob, 'id'>, url: string) {
    const current = ownsResult(url)
    const seed = sd.resultSeed.value
    const context = deps.resultContext.value
    if (!deps.autoSaveToGallery.value) {
      if (current()) displayedResultHistoryId.value = null
      try {
        const blob = await (await fetch(url, { cache: 'no-store' })).blob()
        if (blob.size) {
          await captureTemp({
            engine: 'sd',
            prompt: job.prompt,
            negative: job.negative,
            seed,
            size: job.size,
            animaMetadata: null,
            context,
          }, blob, url, current)
        }
      } catch (error) {
        console.warn('[temp-result] sd capture failed', error)
      }
      return
    }
    try {
      const saved = await deps.commitJobResult(job, url)
      if (!saved) throw new Error('作品册写入失败')
      if (current()) {
        displayedResultHistoryId.value = saved.id
        releaseTemp()
        pb.flash('已自动存入作品册')
      }
    } catch (e) {
      console.warn('direct autosave failed', e)
      if (!current()) return
      pb.flash('自动入册失败，可手动点「存入作品册」')
      try {
        const blob = await (await fetch(url)).blob()
        await captureTemp({ engine: 'sd', prompt: job.prompt, negative: job.negative,
          seed, size: job.size, context }, blob, url, current)
      } catch { if (current()) pb.flash('临时保存也未成功，请下载当前原图') }
    }
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
        context: frozen, seed: deps.displayResultSeed.value ?? undefined,
        ...deps.historyGenerationFields(), story: frozen?.story,
        scene: frozen ? (frozen.sceneId ?? null) : undefined,
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
        const response = await fetch(url, { cache: 'no-store' })
        const contentType = response.headers.get('content-type') || ''
        if (!response.ok || !contentType.startsWith('image/')) {
          pb.flash('成片响应无效，请重新生成')
          return
        }
        blob = await response.blob()
        // 按图取词：SD 结果记录的是提交时实际使用的提示词，面板后续修改不漂移。
        prompt = resultPrompt || prompt
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
    const record = readTempResult()
    if (!record) return false
    let blob: Blob | null = null
    try {
      blob = await imgGet(record.imageId)
    } catch { /* 读取失败按失效处理 */ }
    if (!blob || !blob.size) {
      clearTempResult()
      return false
    }
    // 引擎守卫前置还原（setDrawEngine 对 popular→SD、triad→Anima 有拒绝分支）：
    // 先回到出图时的角色归属，再切引擎，保证恢复结果真的可见。
    if (record.engine === 'sd' && pb.isPopular) pb.setStudioSubject()
    const originChar = record.context?.char
    if (originChar === 'nene' || originChar === 'natsume' || originChar === 'triad') {
      pb.setChar(originChar)
    }
    if (record.engine === 'sd') {
      deps.sd.adoptResult(URL.createObjectURL(blob), record.seed, record.prompt)
      deps.resultContext.value = record.context ?? null
      deps.setDrawEngine('sd')
    } else {
      if (!record.animaMetadata) {
        clearTempResult()
        return false
      }
      deps.patchAnimaState({
        result: { url: URL.createObjectURL(blob), blob, metadata: record.animaMetadata },
        job: record.animaMetadata,
        resultContext: record.context ?? null,
        phase: 'succeeded',
        progress: 1,
        statusText: '已找回上次未入册的成片',
        errorMsg: '',
        errorReport: null,
      })
      deps.setDrawEngine(record.engine === 'krea2' ? 'krea2' : 'anima')
    }
    pb.flash('已找回上次未入册的成片：可点「存入作品册」，或点「清除」丢弃')
    storedResultUrl.value = deps.displayResultUrl.value
    return true
  }

  /** 用户显式「清除」舞台结果：临时缓冲一并丢弃（显式丢弃优于一切恢复）。 */
  function discardTemp() {
    resultRevision += 1
    releaseTemp()
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

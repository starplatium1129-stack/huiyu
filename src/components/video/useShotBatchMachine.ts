import { useTrackedTask } from '@/composables/useTaskCenter'
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, type ComputedRef, type Ref } from 'vue'
import {
  cancelVideoBatch,
  concatVideoBatch,
  createVideoBatch,
  fetchVideoBatch,
  retryVideoShot,
  type VideoBatch,
  type VideoQuality,
} from '@/api/videoApi'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { ApiClientError } from '@/api/client'
import type { ShotDraft } from './shotListTypes'
import type { ShotSubmissionRecord } from '@/stores/videoStore'
import type { ShotCastRef } from './useReferenceCards'

export interface ShotBatchMachineDeps {
  shots: Ref<ShotDraft[]>
  identityCard: Ref<string>
  aspectRatio: Ref<VideoBatch['aspectRatio']>
  quality: Ref<VideoQuality>
  steps: Ref<4 | 8>
  linkLastFrame: Ref<boolean>
  /** 镜头 → Ref2VA 参考图文件名数组（useReferenceCards.shotReferences）。 */
  shotReferences: (shot: ShotCastRef) => string[] | undefined
  h3Ready: ComputedRef<boolean>
  /** ComfyUI 在线（props.status.online）。 */
  online: ComputedRef<boolean>
  inputsBusy?: ComputedRef<boolean>
  /** 宿主持有的用户可见错误通道（提交/轮询/重抽失败回写）。 */
  batchError: Ref<string>
  onAccepted?: (batch: VideoBatch) => void
  onSubmitting?: (targets: ShotDraft[]) => void
  onSubmissionRejected?: (targets: ShotDraft[]) => void
  onSubmitted?: (targets: ShotDraft[], batchId: string) => void
}

/**
 * 分镜编辑器·批量提交状态机（2026-08-22 自 ShotListEditor 下沉）。
 *
 * 持有整批任务（VideoBatch）生命周期：提交（逐镜组装载荷，身份锚点前置）、
 * 3s 轮询（running/paused 才续订）、取消、单镜/整批重抽、拼接成片。
 * 卸载时自动停轮询；镜头草稿编辑与 AI 整理仍归宿主。
 */
export function useShotBatchMachine(deps: ShotBatchMachineDeps) {
  const { shots, identityCard, aspectRatio, quality, steps, linkLastFrame, shotReferences, h3Ready, online, batchError } = deps

  const batch = ref<VideoBatch | null>(null)
  const submitting = ref(false)
  const cancelling = ref(false)
  const concating = ref(false)
  const retrying = ref(false)
  let pollTimer = 0
  let disposed = false
  let pageActive = true
  let pollRequest: AbortController | null = null
  let reconnectRequest: AbortController | null = null
  let reconnectTarget = ''
  let reconnectSerial = 0
  let operationSerial = 0
  const shotSubmissions = new WeakMap<ShotDraft, ShotSubmissionRecord>()

  function stopReads() {
    window.clearTimeout(pollTimer)
    pollRequest?.abort(); pollRequest = null
    reconnectRequest?.abort(); reconnectRequest = null
  }
  function beginOperation() {
    stopReads()
    reconnectTarget = ''
    return ++operationSerial
  }

  function acceptBatch(value: VideoBatch) {
    if (batch.value?.id !== value.id) deps.onAccepted?.(value)
    if (!disposed) batch.value = value
  }
  function acceptRetry(value: VideoBatch, sourceId: string) {
    if (value.retrySource || value.id !== sourceId) {
      batchError.value = '已提交独立重抽任务，请在任务中心查看结果；原失败镜头尚未替换，结果不会自动回并或续拼接。'
    } else batch.value = value
  }

  const batchActive = computed(() => batch.value?.status === 'running')
  const canSubmit = computed(() =>
    shots.value.length > 0
    && shots.value.every((shot) => shot.prompt.trim().length >= 8 && shot.prompt.trim().length <= 4000)
    && !submitting.value
    && !deps.inputsBusy?.value
    && !retrying.value && !cancelling.value && !concating.value
    && h3Ready.value
    && shots.value.every(shot => !shot.seedText.trim() || (Number.isSafeInteger(Number(shot.seedText)) && Number(shot.seedText) >= 0 && Number(shot.seedText) <= 0x7fffffff))
    && !batchActive.value
    && online.value)
  const canConcat = computed(() =>
    batch.value !== null
    && (batch.value.progress.succeeded >= 2)
    && !batch.value.concatAvailable
    && batch.value.status === 'done')
  const progressPercent = computed(() => {
    const total = batch.value?.progress.total ?? 0
    if (!total) return 0
    const done = batch.value?.progress.succeeded ?? 0
    const failed = batch.value?.progress.failed ?? 0
    return Math.min(100, Math.round(((done + failed) / total) * 100))
  })

  function getShotSubmission(shot: ShotDraft) {
    const submission = shotSubmissions.get(shot)
    return submission ? { ...submission } : undefined
  }
  function restoreShotSubmission(shot: ShotDraft, submission: ShotSubmissionRecord | undefined) {
    if (submission && typeof submission.batchId === 'string' && submission.batchId
      && Number.isSafeInteger(submission.shotIndex) && submission.shotIndex >= 0) {
      shotSubmissions.set(shot, { batchId: submission.batchId, shotIndex: submission.shotIndex })
    }
  }
  function submittedIndex(index: number) {
    const submission = Number.isInteger(index) && shots.value[index] ? shotSubmissions.get(shots.value[index]) : undefined
    return submission && submission.batchId === batch.value?.id ? submission.shotIndex : -1
  }
  function serverShot(index: number) {
    return batch.value?.shots[submittedIndex(index)] ?? null
  }

  function parsedSeed(shot: ShotDraft): number | undefined {
    if (!shot.seedText.trim()) return undefined
    const value = Number(shot.seedText)
    return Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff ? value : undefined
  }

  async function submitBatch() {
    if (!canSubmit.value || !h3Ready.value) return
    submitting.value = true
    const serial = beginOperation()
    batchError.value = ''
    const targets = shots.value.slice()
    try {
      deps.onSubmitting?.(targets)
      const response = await createVideoBatch({
        modelId: 'minimax-h3',
        aspectRatio: aspectRatio.value,
        quality: quality.value,
        steps: steps.value,
        linkLastFrame: linkLastFrame.value,
        // 成人内容传输层授权：本机直连默认 true，远程/隧道由服务端 fail-closed。
        adultEnabled: isLocalStudioHost(),
        shots: targets.map((shot) => {
          const prompt = [identityCard.value.trim(), shot.prompt.trim()].filter(Boolean).join('\n')
          return {
            prompt,
            dialogue: shot.dialogue.trim() || undefined,
            shotSize: shot.shotSize || undefined,
            camera: shot.camera,
            motion: shot.motion,
            duration: shot.duration,
            seed: parsedSeed(shot),
            image: shot.imageName || undefined,
            references: shotReferences(shot),
          }
        }),
      })
      if (serial !== operationSerial) { deps.onSubmissionRejected?.(targets); return }
      targets.forEach((shot, shotIndex) => shotSubmissions.set(shot, { batchId: response.batch.id, shotIndex }))
      acceptBatch(response.batch)
      // Accepted task provenance must survive leaving; the draft owner rejects stale saves.
      deps.onSubmitted?.(targets, response.batch.id)
    } catch (error) {
      deps.onSubmissionRejected?.(targets)
      if (!disposed && serial === operationSerial) batchError.value = error instanceof Error ? error.message : '批量提交失败'
    } finally {
      submitting.value = false
      schedulePoll()
    }
  }

  async function pollBatch() {
    if (!batch.value || disposed || !pageActive || pollRequest || submitting.value || retrying.value || cancelling.value || concating.value) return
    if (batch.value.status !== 'running' && batch.value.status !== 'paused') return
    const id = batch.value.id
    const serial = operationSerial
    const controller = new AbortController(); pollRequest = controller
    try {
      const response = await fetchVideoBatch(id, controller.signal)
      if (disposed || !pageActive || controller.signal.aborted || batch.value?.id !== id || serial !== operationSerial) return
      batch.value = response.batch
    } catch (error) {
      if (disposed || !pageActive || controller.signal.aborted || batch.value?.id !== id || serial !== operationSerial) return
      batchError.value = error instanceof Error ? error.message : '批量状态读取失败'
    } finally {
      if (pollRequest === controller) { pollRequest = null; schedulePoll() }
    }
  }

  function schedulePoll() {
    window.clearTimeout(pollTimer)
    if (!batch.value || disposed || !pageActive || pollRequest || submitting.value || retrying.value || cancelling.value || concating.value) return
    if (batch.value.status !== 'running' && batch.value.status !== 'paused') return
    pollTimer = window.setTimeout(() => { void pollBatch() }, 3000)
  }

  async function cancelBatch() {
    if (!batch.value || cancelling.value) return
    const id = batch.value.id
    const serial = beginOperation()
    cancelling.value = true
    try {
      const response = await cancelVideoBatch(id)
      if (disposed || batch.value?.id !== id || serial !== operationSerial) return
      batch.value = response.batch
    } catch (error) {
      if (!disposed && batch.value?.id === id && serial === operationSerial) batchError.value = error instanceof Error ? error.message : '整批取消失败'
    } finally {
      cancelling.value = false
      schedulePoll()
    }
  }

  async function retryShotAt(index: number) {
    const sourceIndex = submittedIndex(index)
    if (!batch.value || retrying.value || cancelling.value || concating.value || sourceIndex < 0 || !batch.value.shots[sourceIndex]) return
    const id = batch.value.id
    const serial = beginOperation()
    retrying.value = true
    try {
      const response = await retryVideoShot(id, sourceIndex + 1)
      if (disposed || batch.value?.id !== id || serial !== operationSerial) return
      acceptRetry(response.batch, id)
    } catch (error) {
      if (!disposed && batch.value?.id === id && serial === operationSerial) batchError.value = error instanceof Error ? error.message : '重抽失败'
    } finally {
      retrying.value = false
      schedulePoll()
    }
  }

  async function retryAllFailed() {
    if (!batch.value || retrying.value || cancelling.value || concating.value) return
    const id = batch.value.id
    const serial = beginOperation()
    const indices = batch.value.shots.flatMap((shot, index) => shot.status === 'failed' || shot.status === 'cancelled' ? [index] : [])
    retrying.value = true
    batchError.value = ''
    try {
      for (const index of indices) {
        if (disposed || batch.value?.id !== id || serial !== operationSerial) return
        try {
          const response = await retryVideoShot(id, index + 1)
          if (disposed || batch.value?.id !== id || serial !== operationSerial) return
          acceptRetry(response.batch, id)
        } catch (error) {
          if (disposed || batch.value?.id !== id || serial !== operationSerial) return
          batchError.value = error instanceof Error ? error.message : '重抽失败'
          return
        }
      }
    } finally {
      retrying.value = false
      schedulePoll()
    }
  }

  async function concatBatch() {
    if (!batch.value || concating.value || retrying.value || cancelling.value || !canConcat.value) return
    const id = batch.value.id
    const serial = beginOperation()
    concating.value = true
    try {
      const response = await concatVideoBatch(id)
      if (disposed || batch.value?.id !== id || serial !== operationSerial) return
      batch.value = response.batch
    } catch (error) {
      if (!disposed && batch.value?.id === id && serial === operationSerial) batchError.value = error instanceof Error ? error.message : '拼接失败'
    } finally {
      concating.value = false
    }
  }

  /**
   * 离页重连（2026-09-06 体验报告 F1）：批量任务在服务端续跑，前端只停轮询；
   * 回到分镜页时按记录的 batchId 拉取真实状态并恢复轮询。批次不存在返回
   * false，由宿主清记录并向用户解释。
   */
  async function reconnectBatch(id: string): Promise<boolean> {
    reconnectTarget = id
    if (disposed || !pageActive) return true
    stopReads()
    const serial = ++reconnectSerial, operation = ++operationSerial
    if (batch.value?.id === id) { reconnectTarget = ''; schedulePoll(); return true }
    const previousId = batch.value?.id
    const controller = new AbortController(); reconnectRequest = controller
    const current = () => !disposed && !controller.signal.aborted && serial === reconnectSerial
      && operation === operationSerial && batch.value?.id === previousId
    let returningToSource = false
    try {
      let response = await fetchVideoBatch(id, controller.signal)
      if (!current()) return true
      if (response.batch.retrySource) {
        returningToSource = true
        const sourceId = response.batch.retrySource.batchId
        if (sourceId === id) throw new Error('重抽来源无法确认，请在任务中心查看独立结果。')
        response = await fetchVideoBatch(sourceId, controller.signal)
        if (!current()) return true
        if (response.batch.retrySource) throw new Error('重抽来源无法确认，请在任务中心查看独立结果。')
      }
      reconnectTarget = ''
      acceptBatch(response.batch)
      if (returningToSource) batchError.value = '当前显示原分镜批次；重抽结果独立保留在任务中心，尚未替换原镜头或自动续拼接。'
      schedulePoll()
      return true
    } catch (error) {
      if (!current()) return true
      if (error instanceof ApiClientError && (error.status === 404 || error.status === 410 || returningToSource && error.status === 403)) {
        reconnectTarget = ''
        batchError.value = returningToSource ? '原分镜批次不存在或无权访问；独立重抽结果仍请到任务中心查看，未绑定到当前草稿。'
          : '上一批分镜任务已不存在，镜头草稿仍在，可重新提交。'
        return false
      }
      batchError.value = error instanceof Error ? error.message : '批次暂时无法读取，请稍后重试'
      return true
    } finally { if (reconnectRequest === controller) reconnectRequest = null }
  }

  onDeactivated(() => { pageActive = false; stopReads() })
  onActivated(() => { pageActive = true; if (reconnectTarget) void reconnectBatch(reconnectTarget); else void pollBatch() })
  onBeforeUnmount(() => {
    disposed = true
    pageActive = false
    stopReads()
  })

  useTrackedTask(() => ({ kind: 'video', title: '分镜批量视频', backend: !submitting.value && batch.value ? { kind: 'video-batch', id: batch.value.id } : undefined, route: batch.value ? '/video-studio?mode=shots&batch=' + encodeURIComponent(batch.value.id) : '/video-studio?mode=shots', resultRoute: batch.value ? '/video-studio?mode=shots&batch=' + encodeURIComponent(batch.value.id) : undefined, status: submitting.value || concating.value || batchActive.value ? 'running' : !batch.value ? 'idle' : batchError.value || batch.value.status === 'paused' || batch.value.progress.failed ? 'failed' : batch.value.status === 'cancelled' ? 'cancelled' : 'succeeded', progress: progressPercent.value, message: batchError.value || (concating.value ? '正在拼接成片…' : batch.value ? `${batch.value.progress.succeeded} / ${batch.value.progress.total} 镜完成` : '') }), { get cancel() { return concating.value ? undefined : cancelBatch }, get retry() { return batch.value?.progress.failed ? retryAllFailed : undefined } })
  return {
    batch,
    submitting,
    cancelling,
    concating,
    retrying,
    batchActive,
    canSubmit,
    canConcat,
    progressPercent,
    serverShot,
    getShotSubmission,
    restoreShotSubmission,
    submitBatch,
    cancelBatch,
    retryShotAt,
    retryAllFailed,
    concatBatch,
    reconnectBatch,
  }
}

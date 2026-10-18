import { useTrackedTask } from '@/composables/useTaskCenter'
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, type ComputedRef, type Ref } from 'vue'
import { cancelVideoBatch, concatVideoBatch, fetchVideoBatch, type VideoBatch, type VideoQuality } from '@/api/videoApi'
import { prepareRuntimeVideoRetry } from '@/api/runtimeVideo'
import { hasRuntimeTasks, isRuntimeTaskId } from '@/api/runtimeTasks'
import { useVideoRequest, videoRequestSettled } from '@/composables/video/useVideoRequest'
import { VIDEO_BATCH_REQUEST_DRAFT_KEY } from '@/utils/storageKeys'
import { sameTempResultOwner, tempResultOwner } from '@/utils/tempResult'
import { flushProfileWrites } from '@/platform/web/profileStorage'
import { useVideoStore, type ShotSubmissionRecord } from '@/stores/videoStore'
import type { ShotDraft } from './shotListTypes'
import type { ShotCastRef } from './useReferenceCards'

export interface ShotBatchMachineDeps {
  shots: Ref<ShotDraft[]>
  identityCard: Ref<string>
  aspectRatio: Ref<VideoBatch['aspectRatio']>
  quality: Ref<VideoQuality>
  steps: Ref<4 | 8>
  linkLastFrame: Ref<boolean>
  shotReferences: (shot: ShotCastRef) => string[] | undefined
  h3Ready: ComputedRef<boolean>
  online: ComputedRef<boolean>
  inputsBusy?: ComputedRef<boolean>
  batchError: Ref<string>
  onSubmitting: (targets: ShotDraft[]) => Promise<string[]>
  onSubmissionRejected: (targets: ShotDraft[]) => Promise<void>
  onSubmitted: (tokens: string[], batchId?: string) => Promise<void>
}

/** Admission and row provenance survive presentation changes; reads never submit. */
export function useShotBatchMachine(deps: ShotBatchMachineDeps) {
  const { shots, identityCard, aspectRatio, quality, steps, linkLastFrame, shotReferences, h3Ready, online, batchError } = deps
  const batch = ref<VideoBatch | null>(null), submitting = ref(false), cancelling = ref(false), concating = ref(false), retrying = ref(false)
  const batchReadError = ref(''), batchReading = ref(false), batchReadRetryable = ref(false)
  const submission = useVideoRequest('batch', VIDEO_BATCH_REQUEST_DRAFT_KEY, async draft => {
    const tokens = Array.isArray(draft.details?.tokens) ? draft.details.tokens.filter((token): token is string => typeof token === 'string') : []
    await deps.onSubmitted(tokens)
  }), videoStore = useVideoStore(), pageOwner = tempResultOwner()
  const legacyVerified = ref(false), reconnectTarget = ref('')
  const shotSubmissions = new WeakMap<ShotDraft, ShotSubmissionRecord>()
  let pollTimer = 0, disposed = false, pageActive = true, operationSerial = 0
  let readRequest: AbortController | null = null
  function check() {
    submission.check()
    if (!sameTempResultOwner(pageOwner)) throw new Error('分镜所属工作区已变化，请回到原连接核对')
    if (videoStore.shotsBatchIssue) throw new Error(videoStore.shotsBatchIssue)
  }
  function stopReads() { window.clearTimeout(pollTimer); readRequest?.abort(); readRequest = null; batchReading.value = false }
  function beginOperation() { stopReads(); batchReadError.value = ''; batchReadRetryable.value = false; return ++operationSerial }
  const batchActive = computed(() => batch.value?.status === 'running')
  const batchRecoveryPending = computed(() => Boolean(reconnectTarget.value || submission.pending.value || videoStore.shotsBatchIssue
    || videoStore.shotsBatch && !legacyVerified.value || batch.value?.needsReview))
  const batchSelectionPending = computed(() => Boolean(reconnectTarget.value && reconnectTarget.value !== batch.value?.id))
  const canSubmit = computed(() => shots.value.length > 0 && shots.value.every(shot => shot.prompt.trim().length >= 8 && shot.prompt.trim().length <= 4000)
    && !submitting.value && !batchRecoveryPending.value && !deps.inputsBusy?.value && !retrying.value && !cancelling.value && !concating.value
    && h3Ready.value && online.value && !batchActive.value
    && shots.value.every(shot => !shot.seedText.trim() || Number.isSafeInteger(Number(shot.seedText)) && Number(shot.seedText) >= 0 && Number(shot.seedText) <= 0x7fffffff))
  const canConcat = computed(() => Boolean(batch.value && !batchRecoveryPending.value && batch.value.progress.succeeded >= 2 && !batch.value.concatAvailable && batch.value.status === 'done'))
  const progressPercent = computed(() => Math.min(100, Math.round(((batch.value?.progress.succeeded || 0) + (batch.value?.progress.failed || 0)) / Math.max(1, batch.value?.progress.total || 0) * 100)))
  const requestPending = submission.pending
  function getShotSubmission(shot: ShotDraft) { const value = shotSubmissions.get(shot); return value ? { ...value } : undefined }
  function restoreShotSubmission(shot: ShotDraft, value: ShotSubmissionRecord | undefined) {
    if (value?.batchId && Number.isSafeInteger(value.shotIndex) && value.shotIndex >= 0) shotSubmissions.set(shot, { ...value })
  }
  function submittedIndex(index: number) {
    const value = shots.value[index] && shotSubmissions.get(shots.value[index])
    return value?.batchId === batch.value?.id ? value!.shotIndex : -1
  }
  function serverShot(index: number) { return batch.value?.shots[submittedIndex(index)] ?? null }
  async function adopt(value: VideoBatch) {
    check()
    const details = submission.request.value?.details
    if (details?.retrySource) {
      const source = details.retrySource as { batchId: string }
      if (value.id !== source.batchId) batchError.value = '重抽任务独立保留在任务中心，未替换原镜头或自动续拼接。'
      return
    }
    if (details?.adopted === true) return
    const tokens = Array.isArray(details?.tokens) ? details.tokens.filter((token): token is string => typeof token === 'string') : []
    await deps.onSubmitted(tokens, value.id)
    await submission.confirmAdoption()
  }
  async function recoverRequest(signal: AbortSignal): Promise<VideoBatch | null> {
    if (!submission.request.value) { check(); return null }
    const value = await submission.observe(signal)
    if (!value || !('shots' in value)) throw new Error('原分镜请求返回了错误的任务类型')
    await adopt(value)
    return value
  }
  async function submitBatch() {
    if (!canSubmit.value) return
    submitting.value = true
    const serial = beginOperation(), targets = shots.value.slice()
    batchError.value = ''
    try {
      check()
      const input = { modelId: 'minimax-h3', aspectRatio: aspectRatio.value, quality: quality.value, steps: steps.value, linkLastFrame: linkLastFrame.value,
        shots: targets.map(shot => ({ prompt: [identityCard.value.trim(), shot.prompt.trim()].filter(Boolean).join('\n'), dialogue: shot.dialogue.trim() || undefined,
          shotSize: shot.shotSize || undefined, camera: shot.camera, motion: shot.motion, duration: shot.duration,
          seed: shot.seedText.trim() ? Number(shot.seedText) : undefined, image: shot.imageName || undefined, references: shotReferences(shot) })) }
      const tokens = await deps.onSubmitting(targets)
      check()
      if (videoStore.shotsBatch) { videoStore.clearShotsBatch(); await flushProfileWrites() }
      const value = await submission.submit(input, new AbortController().signal, undefined, { tokens })
      if (!('shots' in value)) throw new Error('原分镜请求类型不符')
      // Adoption must finish even after a deep link changes the displayed batch.
      await adopt(value)
      targets.forEach((shot, shotIndex) => shotSubmissions.set(shot, { batchId: value.id, shotIndex }))
      if (!disposed && serial === operationSerial) batch.value = value
    } catch (error) {
      if (!submission.pending.value) await deps.onSubmissionRejected(targets)
      if (!disposed) { batchError.value = error instanceof Error ? error.message : '分镜接收状态待核对'; batchReadRetryable.value = true; batchReadError.value = batchError.value }
    } finally { submitting.value = false; schedulePoll() }
  }
  function schedulePoll() {
    window.clearTimeout(pollTimer)
    if (disposed || !pageActive || readRequest || submitting.value || retrying.value || cancelling.value || concating.value) return
    if (submission.pending.value || batch.value?.status === 'running' || batch.value?.status === 'paused') pollTimer = window.setTimeout(() => { void readBatch() }, 3000)
  }
  async function readBatch() {
    if (disposed || !pageActive || readRequest || submitting.value || retrying.value || cancelling.value || concating.value) return
    const controller = new AbortController(), serial = operationSerial
    readRequest = controller; batchReading.value = true
    try {
      check()
      const recovered = submission.pending.value ? await recoverRequest(controller.signal) : null
      const source = submission.request.value?.details?.retrySource as { batchId?: string } | undefined
      const id = reconnectTarget.value || batch.value?.id || source?.batchId || recovered?.id || submission.request.value?.taskId || videoStore.shotsBatch?.batchId
      if (!id) return
      let value = recovered?.id === id ? recovered : (await fetchVideoBatch(id, controller.signal)).batch
      check(); submission.update(value)
      if (value.retrySource) {
        if (value.retrySource.batchId === value.id) throw new Error('重抽来源无法确认，请到任务中心查看结果')
        value = (await fetchVideoBatch(value.retrySource.batchId, controller.signal)).batch
        check(); batchError.value = '当前显示原分镜批次；独立重抽结果保留在任务中心。'
      }
      if (disposed || controller.signal.aborted || serial !== operationSerial) return
      legacyVerified.value = !videoStore.shotsBatch || value.id === videoStore.shotsBatch.batchId && videoRequestSettled(value)
      batch.value = value; reconnectTarget.value = ''; batchReadError.value = ''; batchReadRetryable.value = false
    } catch (error) {
      if (disposed || controller.signal.aborted || serial !== operationSerial) return
      batchReadError.value = error instanceof Error ? error.message : '原批次暂时无法读取；身份已保留，不会重新提交'
      batchReadRetryable.value = true
    } finally { if (readRequest === controller) { readRequest = null; batchReading.value = false; if (!batchReadError.value) schedulePoll() } }
  }
  async function cancelBatch(original = false) {
    if (cancelling.value || !original && batchSelectionPending.value || !batch.value && !submission.request.value) return
    const serial = beginOperation(); cancelling.value = true
    try {
      check()
      const owned = submission.request.value
      const value = owned && (original || !batch.value || owned.taskId === batch.value?.id) ? await submission.cancel()
        : batch.value ? (await cancelVideoBatch(batch.value.id)).batch : null
      check()
      if (!disposed && serial === operationSerial) {
        if (value && 'shots' in value && (!batch.value || value.id === batch.value.id)) batch.value = value
        if (!value) { reconnectTarget.value = ''; batchReadError.value = ''; batchError.value = '取消意图已写稳，原请求不会再执行' }
      }
    } catch (error) { batchError.value = error instanceof Error ? error.message : '整批取消状态待确认' }
    finally { cancelling.value = false; schedulePoll() }
  }
  async function retryIndices(indices: number[]) {
    if (!batch.value || batchActive.value || retrying.value || cancelling.value || concating.value || batchRecoveryPending.value || !indices.length) return
    const id = batch.value.id, serial = beginOperation()
    retrying.value = true; batchError.value = ''
    try {
      check()
      if (isRuntimeTaskId(id) !== hasRuntimeTasks()) throw new Error('请回到原任务所属连接重抽')
      const prepared = isRuntimeTaskId(id) ? await prepareRuntimeVideoRetry(id, indices) : { input: { indices }, context: undefined }
      check()
      const value = await submission.submit(prepared.input, new AbortController().signal, prepared.context, { retrySource: { batchId: id, indices } })
      if (!('shots' in value)) throw new Error('重抽任务类型不符')
      if (!disposed && serial === operationSerial) {
        if (value.id === id) batch.value = value
        else batchError.value = '重抽任务独立保留在任务中心，未替换原镜头或自动续拼接。'
      }
    } catch (error) {
      batchError.value = error instanceof Error ? error.message : '重抽接收状态待核对'
      batchReadError.value = batchError.value; batchReadRetryable.value = true
    } finally { retrying.value = false; schedulePoll() }
  }
  async function retryShotAt(index: number) {
    const position = submittedIndex(index), value = batch.value?.shots[position]
    if (value && ['failed', 'cancelled'].includes(value.status)) await retryIndices([position + 1])
  }
  async function retryAllFailed() {
    await retryIndices(batch.value?.shots.flatMap((shot, index) => ['failed', 'cancelled'].includes(shot.status) ? [index + 1] : []) || [])
  }
  async function concatBatch() {
    if (!batch.value || !canConcat.value || concating.value || retrying.value || cancelling.value) return
    const id = batch.value.id, serial = beginOperation(); concating.value = true
    try {
      check()
      const value = (await concatVideoBatch(id)).batch
      check(); submission.update(value)
      if (!disposed && serial === operationSerial && batch.value?.id === id) batch.value = value
    } catch (error) { batchError.value = error instanceof Error ? error.message : '拼接未确认，请重新读取原批次后核对' }
    finally { concating.value = false }
  }
  async function reconnectBatch(id = '') {
    stopReads(); operationSerial++
    reconnectTarget.value = id
    batchReadError.value = ''; batchReadRetryable.value = false
    await readBatch()
  }
  onDeactivated(() => { pageActive = false; stopReads() })
  onActivated(() => { pageActive = true; void readBatch() })
  onBeforeUnmount(() => { disposed = true; pageActive = false; stopReads() })
  useTrackedTask(() => ({ kind: 'video', title: '分镜批量视频', backend: batch.value ? { kind: 'video-batch', id: batch.value.id } : undefined,
    route: batch.value ? '/video-studio?mode=shots&batch=' + encodeURIComponent(batch.value.id) : '/video-studio?mode=shots',
    resultRoute: batch.value ? '/video-studio?mode=shots&batch=' + encodeURIComponent(batch.value.id) : undefined,
    status: submitting.value || concating.value || batchActive.value ? 'running' : batchRecoveryPending.value ? 'interrupted' : !batch.value ? 'idle'
      : batchError.value || batch.value.status === 'paused' || batch.value.progress.failed ? 'failed' : batch.value.status === 'cancelled' ? 'cancelled' : 'succeeded',
    progress: batchRecoveryPending.value ? null : progressPercent.value, message: batchReadError.value || batchError.value }),
  { get cancel() { return concating.value ? undefined : cancelBatch }, get retry() { return !batchRecoveryPending.value && batch.value?.progress.failed ? retryAllFailed : undefined } })
  return { batch, batchReadError, batchReading, batchReadRetryable, batchRecoveryPending, batchSelectionPending, requestPending,
    submitting, cancelling, concating, retrying, batchActive, canSubmit, canConcat, progressPercent, serverShot, getShotSubmission, restoreShotSubmission,
    submitBatch, cancelBatch: () => cancelBatch(), cancelOriginalRequest: () => cancelBatch(true), retryShotAt, retryAllFailed, concatBatch, reconnectBatch }
}

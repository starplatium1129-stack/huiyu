import { watch, type ComputedRef, type Ref } from 'vue'
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router'
import { cancelVideoJob, type VideoAttention, type VideoDefaults, type VideoDriver, type VideoJob } from '@/api/videoApi'
import { classifySDError } from '@/utils/sdError'
import { flushProfileWrites } from '@/platform/web/profileStorage'
import { onDesktopRuntime } from '@/platform/desktop/runtime'
import { imageMediaSession } from '@/platform/imageMediaSession'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import type { useVideoStore } from '@/stores/videoStore'
import type { VideoPromptSource } from '../../../types/videoPrompt'
import type { StudioMode } from './useVideoModeOptions'
import { videoRequestSettled, type useVideoRequest } from './useVideoRequest'
import type { useVideoJobObservation } from './useVideoJobObservation'

export interface VideoJobCommandsDeps {
  route: RouteLocationNormalizedLoaded
  router: Router
  videoStore: ReturnType<typeof useVideoStore>
  submission: ReturnType<typeof useVideoRequest>
  observation: ReturnType<typeof useVideoJobObservation>
  job: Ref<VideoJob | null>
  submitting: Ref<boolean>
  cancelling: Ref<boolean>
  ownsTrackedTask: Ref<boolean>
  unboundTaskStatus: Ref<'interrupted' | 'failed' | 'cancelled'>
  statusError: Ref<string>
  selectedTaskId: Ref<string>
  selectedMode: Ref<StudioMode>
  selectedModelId: Ref<string>
  aspectRatio: Ref<VideoDefaults['aspectRatio']>
  quality: Ref<VideoDefaults['quality']>
  steps: Ref<4 | 8>
  videoAttention: Ref<VideoAttention>
  nativeVideo: ComputedRef<boolean>
  promptSource: ComputedRef<VideoPromptSource>
  parsedSeed: ComputedRef<number | null | undefined>
  driver: ComputedRef<VideoDriver | null>
  h3Input: ComputedRef<Record<string, unknown>>
  canGenerate: ComputedRef<boolean>
  isDisposed: () => boolean
  isPageActive: () => boolean
  getSelectionVersion: () => number
  bumpSelectionVersion: () => number
  checkOwner: () => void
  resolveSubmitFrames: (mode: StudioMode, signal: AbortSignal) => Promise<Record<string, unknown>>
  loadStatus: () => Promise<void>
  reconnectVideo: () => Promise<void>
  retrySelectedJob: () => Promise<boolean>
}

export function useVideoJobCommands(deps: VideoJobCommandsDeps) {
  let submitRequest: AbortController | null = null
  let submitSession = imageMediaSession()

  function invalidateSubmission() {
    const next = imageMediaSession()
    if (submitSession !== next) {
      submitSession = next
      submitRequest?.abort()
    }
  }

  // Keep the command signal current through the journal flush and first POST,
  // including the gap after frame preparation has already completed.
  const stopSubmitRuntime = onDesktopRuntime(invalidateSubmission)
  const stopSubmitSessionWatch = watch(runtimeResourceIdentity, invalidateSubmission, { flush: 'sync' })

  function abortSubmit(clear = false) {
    submitRequest?.abort()
    if (clear) submitRequest = null
  }

  function dispose() {
    stopSubmitRuntime()
    stopSubmitSessionWatch()
    abortSubmit(true)
  }

  async function submitVideo() {
    if (deps.isDisposed() || !deps.isPageActive() || !deps.canGenerate.value) return
    const previousJob = deps.job.value
    deps.ownsTrackedTask.value = false
    deps.statusError.value = ''
    deps.submitting.value = true
    deps.job.value = null
    deps.unboundTaskStatus.value = 'interrupted'
    deps.observation.stop()
    const selection = deps.bumpSelectionVersion()
    deps.selectedTaskId.value = ''
    if (typeof deps.route.query.job === 'string') void deps.router.replace({ query: { ...deps.route.query, job: undefined }, hash: deps.route.hash })
    deps.ownsTrackedTask.value = true
    const controller = new AbortController()
    submitRequest?.abort()
    submitRequest = controller
    try {
      // Only a new explicit generation prepares its input; recovery reads the journal.
      const mode = deps.selectedMode.value
      const request = {
        ...deps.promptSource.value,
        aspectRatio: deps.aspectRatio.value,
        seed: typeof deps.parsedSeed.value === 'number' ? deps.parsedSeed.value : undefined,
        quality: deps.quality.value,
        ...(deps.driver.value?.kind === 'audio' ? { drivingAudio: deps.driver.value.name }
          : deps.driver.value?.kind === 'video' ? { drivingVideo: deps.driver.value.name } : {}),
        ...(deps.nativeVideo.value ? { videoAttention: deps.videoAttention.value } : {}),
        ...(deps.nativeVideo.value ? deps.h3Input.value : deps.selectedModelId.value === 'minimax-h3' ? { steps: deps.steps.value } : {}),
      }
      const frames = await deps.resolveSubmitFrames(mode, controller.signal)
      if (deps.isDisposed() || !deps.isPageActive() || selection !== deps.getSelectionVersion()) return
      deps.checkOwner()
      if (deps.videoStore.videoTask) {
        if (!videoRequestSettled(previousJob) || previousJob?.id !== deps.videoStore.videoTask.jobId) throw new Error('请先读取并核对旧视频任务')
        deps.videoStore.clearVideoTask()
        await flushProfileWrites()
      }
      if (deps.isDisposed() || !deps.isPageActive() || selection !== deps.getSelectionVersion()) return
      controller.signal.throwIfAborted()
      deps.checkOwner()
      const accepted = await deps.submission.submit({ ...request, ...frames }, controller.signal, undefined, { mode })
      if ('shots' in accepted) throw new Error('视频请求返回了错误的任务类型')
      if (deps.isDisposed() || !deps.isPageActive() || selection !== deps.getSelectionVersion()) return
      deps.job.value = accepted
      deps.observation.pollError.value = ''
      deps.observation.recoveryError.value = ''
      deps.observation.reconnectState.value = 'idle'
    } catch (error) {
      if (deps.isDisposed() || !deps.isPageActive() || selection !== deps.getSelectionVersion()) return
      // 按当前引擎给出中文恢复建议，未知错误保留原始消息。
      const report = classifySDError(error, deps.nativeVideo.value ? 'native' : 'comfy')
      const submissionError = report.kind === 'unknown'
        ? (error instanceof Error ? error.message : '视频任务提交失败')
        : `${report.title}：${report.message}`
      if (deps.submission.pending.value) deps.observation.reconnectState.value = 'failed'
      else deps.unboundTaskStatus.value = 'failed'
      await deps.loadStatus()
      if (!deps.isDisposed() && deps.isPageActive() && selection === deps.getSelectionVersion()) {
        deps.statusError.value = deps.submission.pending.value ? '原视频接收状态待核对，已阻止重复提交。' + submissionError : submissionError
      }
    } finally {
      if (submitRequest === controller) submitRequest = null
      deps.submitting.value = false
      if (deps.observation.jobSelectionPending.value) void deps.retrySelectedJob()
      else if (deps.isPageActive() && selection !== deps.getSelectionVersion() && deps.submission.unconfirmed.value) void deps.reconnectVideo()
      else deps.observation.schedule()
    }
  }

  async function cancelJob(original = false) {
    if (deps.isDisposed() || deps.cancelling.value || !original && (deps.observation.jobSelectionPending.value || deps.observation.selectedJobReading.value)) return
    const preparing = submitRequest
    preparing?.abort()
    if (!deps.job.value && !deps.submission.request.value) {
      if (preparing) {
        deps.bumpSelectionVersion()
        deps.unboundTaskStatus.value = 'cancelled'
        deps.statusError.value = '视频准备已停止，尚未提交任务'
      }
      return
    }
    const id = deps.job.value?.id || ''
    const selection = deps.getSelectionVersion()
    // An explicit command can claim this visit; cancelling a different original
    // request cannot make the cached selected clip authoritative.
    if (!original || !deps.job.value || deps.submission.request.value?.taskId === id) deps.ownsTrackedTask.value = true
    deps.cancelling.value = true
    // Cancellation owns the next status; an earlier read cannot turn it back
    // into a running job, and no fresh reads should race the pending command.
    deps.observation.stop()
    try {
      deps.checkOwner()
      const owned = deps.submission.request.value
      const value = owned && (original || !id || owned.taskId === id) ? await deps.submission.cancel() : (await cancelVideoJob(id)).job
      deps.checkOwner()
      if (!deps.isDisposed() && deps.isPageActive() && selection === deps.getSelectionVersion()) {
        if (value && !('shots' in value) && (!deps.job.value || value.id === deps.job.value.id)) deps.job.value = value
        deps.observation.reconnectState.value = 'idle'
        deps.observation.pollError.value = ''
        deps.observation.recoveryError.value = ''
        deps.statusError.value = value ? '' : '取消意图已保存，原请求不会再执行'
        if (!value && !deps.job.value) deps.unboundTaskStatus.value = 'cancelled'
      }
    } catch (error) {
      if (!deps.isDisposed() && deps.isPageActive() && selection === deps.getSelectionVersion()) {
        deps.statusError.value = error instanceof Error ? error.message : '视频任务取消失败'
      }
    } finally {
      deps.cancelling.value = false
      if (deps.observation.jobSelectionPending.value) void deps.retrySelectedJob()
      else if (deps.isPageActive() && selection !== deps.getSelectionVersion() && deps.submission.unconfirmed.value) void deps.reconnectVideo()
      else deps.observation.schedule()
    }
  }

  return { submitVideo, cancelJob, abortSubmit, dispose }
}

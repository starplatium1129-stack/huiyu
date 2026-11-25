import { useVideoJobProgress, formatSeconds, formatTime } from './useVideoJobProgress'
import { generationTask } from '@/utils/generationTask'
import { useTrackedTask } from '@/composables/useTaskCenter'
import { useVideoJobObservation } from './useVideoJobObservation'
import { useVideoEnvironment } from './useVideoEnvironment'
import { useVideoDriver } from './useVideoDriver'
import { computed, onBeforeUnmount, onMounted, ref, watch, onActivated, onDeactivated } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useVideoModeOptions, type StudioMode } from './useVideoModeOptions'
import { useNativeH3Recipe } from './useNativeH3Recipe'
import { fetchVideoJob, fetchVideoStatus,
  type VideoAttention, type VideoDefaults, type VideoJob, type VideoStatusResponse } from '@/api/videoApi'
import { classifySDError } from '@/utils/sdError'
import { useVideoStore } from '@/stores/videoStore'
import { useVideoRequest } from './useVideoRequest'
import { VIDEO_REQUEST_DRAFT_KEY } from '@/utils/storageKeys'
import { sameTempResultOwner, tempResultOwner } from '@/utils/tempResult'
import { useVideoFrames } from '@/components/video/useVideoFrames'
import { useVideoStudioDraft } from '@/components/video/useVideoStudioDraft'
import { hasVideoPromptContent } from '@/components/video/videoPromptPresets'
import type { VideoPromptDrafts, VideoPromptMode, VideoPromptPreviewRequest, VideoPromptRecipe, VideoPromptSource } from '../../../types/videoPrompt'
import { useVideoSubmitState } from './useVideoSubmitState'
import { useVideoJobCommands } from './useVideoJobCommands'

/** Owns workspace state and lifecycle; the view only binds presentation. */
export function useVideoWorkspace() {
  const selectedMode = ref<StudioMode>('text')
  const route = useRoute()
  const router = useRouter()
  const prompt = ref('')
  const promptRecipes = ref<VideoPromptDrafts>({})
  const negative = ref('')
  // 默认选中 H3：主力模型（T8 双时钟加速 / 对白 / 长镜都靠它），Wan 仅作备选。
  // 此前默认 wan2.2 导致用户忘记切换就出片（2026-08-17 用户反馈）。
  const selectedModelId = ref('minimax-h3')
  const aspectRatio = ref<VideoDefaults['aspectRatio']>('landscape')
  const quality = ref<VideoDefaults['quality']>('standard')
  const steps = ref<4 | 8>(8)
  const videoAttention = ref<VideoAttention>('auto')
  const duration = ref<VideoDefaults['duration']>(3)
  const camera = ref<VideoDefaults['camera']>('still')
  const motion = ref<VideoDefaults['motion']>('subtle')
  const seedText = ref('')
  const status = ref<VideoStatusResponse | null>(null)
  const statusLoading = ref(false)
  const statusError = ref('')
  const statusReadError = ref('')
  const submitting = ref(false)
  const cancelling = ref(false)
  const job = ref<VideoJob | null>(null)
  const ownsTrackedTask = ref(false)
  const unboundTaskStatus = ref<'interrupted' | 'failed' | 'cancelled'>('interrupted')
  let detachTrackedBinding: (() => void) | undefined
  const videoStore = useVideoStore()
  const submission = useVideoRequest('video', VIDEO_REQUEST_DRAFT_KEY)
  const pageOwner = tempResultOwner()
  const requestPending = submission.pending
  const requestUnconfirmed = submission.unconfirmed
  const checkOwner = () => { submission.check(); if (!sameTempResultOwner(pageOwner)) throw new Error('视频所属工作区已变化，请回到原连接核对') }

  // Route selections and local submissions share ownership; clearing a consumed
  // deep link must not count as a newer selection than the submission itself.
  const selectedTaskId = ref('')
  let selectionVersion = 0
  let disposed = false
  let pageActive = true
  let statusRequest: AbortController | null = null

  /**
   * 视频任务失败的分类报告（2026-08-30 UX 审计）。
   *
   * 按原任务的执行引擎给出恢复建议，原始错误留在技术细节。
   */
  const jobErrorReport = computed(() => {
    const raw = job.value?.error
    if (!raw || job.value?.needsReview) return null
    return classifySDError({ message: raw }, job.value?.provider || 'comfy')
  })

  // ── 图片动起来（I2VA）状态：首帧来自绘图页「出视频」的跨页上下文 ────────────
  const videoImageId = ref('')
  // ── 首尾帧过渡（FL2VA）状态：首帧可来自绘图页或本地上传，尾帧仅本地上传 ────
  const lastFrameImageId = ref('')

  const activeModel = computed(() => status.value?.models.find(model => model.id === selectedModelId.value) || null)
  const h3 = useNativeH3Recipe(activeModel, videoAttention)
  const { choice: nativeH3Steps, lightVae: h3LightVae } = h3
  const { modes, modeBadge, unsupportedMode, aspectOptions, aspectSize, motionOptions, durationOptions, qualities } =
    useVideoModeOptions(status, statusLoading, statusReadError, selectedMode, quality, activeModel)
  const driverKind = computed(() => selectedMode.value === 'image' ? activeModel.value?.drivingInput : undefined)
  const promptMode = computed<VideoPromptMode>(() => {
    if (driverKind.value === 'video') return 'motion-driver'
    if (driverKind.value === 'audio') return 'voice-driver'
    return selectedMode.value === 'shots' ? 'text' : selectedMode.value
  })
  const emptyRecipe: VideoPromptRecipe = {}
  const promptRecipe = computed<VideoPromptRecipe>({
    get: () => promptRecipes.value[promptMode.value] ?? emptyRecipe,
    set: value => { promptRecipes.value = { ...promptRecipes.value, [promptMode.value]: value } },
  })
  const supportsGeneratedAudio = computed(() => activeModel.value?.supportsGeneratedAudio
    ?? ['minimax-h3', 'ltx-2.3', 'ltx-2.5-distilled', 'kandinsky-6-lite-distill'].includes(selectedModelId.value))
  const supportsDialogueAndMusic = computed(() => supportsGeneratedAudio.value && selectedModelId.value !== 'kandinsky-6-lite-distill')
  const supportsNegative = computed(() => activeModel.value?.supportsNegative ?? selectedModelId.value !== 'minimax-h3')
  const promptContent = computed(() => hasVideoPromptContent(promptMode.value, promptRecipe.value, prompt.value))
  const promptSource = computed<VideoPromptSource>(() => ({
    prompt: prompt.value.trim(),
    promptRecipe: promptRecipe.value,
    ...(supportsNegative.value && negative.value.trim() ? { negative: negative.value.trim() } : {}),
    modelId: selectedModelId.value,
    duration: duration.value,
    camera: camera.value,
    motion: motion.value,
  }))
  const promptPreviewRequest = computed<VideoPromptPreviewRequest | null>(() =>
    selectedMode.value !== 'shots' && promptContent.value && prompt.value.length <= 4000
      ? { ...promptSource.value, mode: selectedMode.value } : null)
  const { source: driverSource, selected: driver, choose: chooseDriver, busy: driverBusy } = useVideoDriver(driverKind, checkOwner, statusError)

  watch([activeModel, videoAttention], ([model, attention]) => {
    if (!model || model.id === 'minimax-h3') return
    if ((model.attentionModes && !model.attentionModes.includes(attention))
      || (attention.startsWith('h3-') && !model.attentionModes?.includes(attention))) videoAttention.value = 'auto'
  })
  watch(aspectOptions, options => {
    if (options[0] && !options.some(option => option.id === aspectRatio.value)) aspectRatio.value = options[0].id
  })
  const { nativeVideo, environmentState, environmentLabel, archiveStatus, archiveState } = useVideoEnvironment({
    status, activeModel, statusLoading, statusReadError, job,
  })
  const h3Issue = computed(() => nativeVideo.value ? h3.issue.value : '')
  watch([durationOptions, duration], ([options, value]) => {
    if (activeModel.value && options[0] && !options.includes(value)) duration.value = options[0]
  })
  watch([qualities, quality], ([options, value]) => {
    if (options[0] && !options.some(option => option.id === value)) quality.value = options[0].id
  })

  const parsedSeed = computed(() => {
    if (!seedText.value.trim()) return undefined
    const value = Number(seedText.value)
    return Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff ? value : null
  })

  const { progressPercent, progressWarning, jobStatusLabel } = useVideoJobProgress(job)

  /** T8 双时钟是 H3 专属路径：仅选中 minimax-h3 时展示徽章（Wan 走原生工作流，与 T8 无关）。 */
  const t8State = computed(() => {
    if (nativeVideo.value || selectedModelId.value !== 'minimax-h3') return null
    return status.value?.t8 ?? null
  })

  // ── 绘图页「出视频」跨页上下文与首帧/尾帧素材（已下沉 useVideoFrames）──────
  // 编辑草稿归 useVideoStudioDraft；接收身份与恢复归 useVideoRequest。
  const {
    videoImageUrl, lastFrameUrl, uploadingImage, hasFirstFrame, hasLastFrame,
    consumeVideoCtx, restorePreviews, clearFirstFrame, clearLastFrame, handleFrameFile, resolveSubmitFrames,
  } = useVideoFrames({
    selectedMode, aspectRatio, selectedModelId, prompt,
    videoImageId, lastFrameImageId, status, statusError,
    available: () => !disposed && pageActive,
    persistImportedCtx: imageId => videoDraftTools.persistImportedCtx(imageId),
  })

  const videoDraftTools = useVideoStudioDraft({
    selectedMode, prompt, promptRecipes, negative, selectedModelId, aspectRatio, quality,
    steps, nativeH3Steps, videoAttention, h3LightVae, driver: driverSource, duration, camera, motion, seedText,
    videoImageId, lastFrameImageId,
    onPersistError: (message) => { statusError.value = message },
  })
  const stopDraftWatch = videoDraftTools.startDraftWatch()

  const observation = useVideoJobObservation({
    job, selectedId: () => selectedTaskId.value,
    available: () => !disposed && pageActive && !submitting.value && !cancelling.value,
    hasRecovery: () => Boolean(submission.request.value || submission.issue.value || videoStore.videoTask || videoStore.videoTaskIssue),
    check: checkOwner,
    async recover(signal) {
      if (videoStore.videoTaskIssue) throw new Error(videoStore.videoTaskIssue)
      const value = submission.request.value ? await submission.observe(signal)
        : videoStore.videoTask ? (await fetchVideoJob(videoStore.videoTask.jobId, signal)).job : null
      if (value && 'shots' in value) throw new Error('视频请求返回了错误的任务类型')
      return value
    },
    update: value => submission.update(value),
    displayed: () => { ownsTrackedTask.value = true },
    selected: () => { statusError.value = '' },
  })
  const { reconnectState, recoveryError, pollError, jobReading, jobActive, jobSelectionPending, selectedJobReading, selectedJobError } = observation
  const statusFeedback = computed(() => statusError.value || statusReadError.value || recoveryError.value || pollError.value)

  const { canGenerate, submitTitle, submitDescription } = useVideoSubmitState({
    selectedMode, hasFirstFrame, hasLastFrame, promptContent, prompt, parsedSeed, activeModel, status,
    nativeVideo, unsupportedMode, h3Issue, statusLoading, statusReadError, submitting, requestPending,
    videoTaskIssue: computed(() => videoStore.videoTaskIssue), uploadingImage, driverBusy, driverKind, driver,
    jobActive, jobNeedsReview: computed(() => Boolean(job.value?.needsReview)), reconnectState,
    jobSelectionPending, selectedJobReading, selectedJobError, duration,
  })

  async function reconnectVideo() {
    const previousError = reconnectState.value === 'failed' ? statusError.value : ''
    if (await observation.recover() && previousError && statusError.value === previousError) statusError.value = ''
  }

  function retrySelectedJob() { return observation.select(true) }

  async function loadStatus() {
    if (disposed || !pageActive) return
    statusRequest?.abort()
    const controller = new AbortController()
    statusRequest = controller
    void retrySelectedJob()
    statusLoading.value = true
    try {
      const next = await fetchVideoStatus(controller.signal)
      if (statusRequest !== controller || controller.signal.aborted || disposed) return
      const newNativeDraft = !status.value && next.provider === 'native' && !videoStore.videoDraft
        && !submission.request.value && !videoStore.videoTask && !route.query.job
      status.value = next
      statusReadError.value = ''
      if (newNativeDraft) selectedModelId.value = next.models.find(model => model.available)?.id ?? next.defaults.modelId
      else if (!next.models.some(model => model.id === selectedModelId.value)) selectedModelId.value = next.defaults.modelId
      const prepared = route.query.preparedModel
      if (typeof prepared === 'string') {
        const mode = selectedMode.value
        if (next.provider === 'native' && !route.query.job && mode !== 'shots' && !submission.request.value && !videoStore.videoTask
          && next.models.some(model => model.id === prepared)) chooseModel(prepared)
        void router.replace({ query: { ...route.query, preparedModel: undefined }, hash: route.hash })
      }
      selectModelForMode()
    } catch (error) {
      if (statusRequest !== controller || controller.signal.aborted || disposed) return
      statusReadError.value = error instanceof Error ? error.message : '视频环境检测失败'
    } finally {
      if (statusRequest === controller) { statusRequest = null; statusLoading.value = false }
    }
  }

  function chooseModel(id: string) {
    selectedModelId.value = id
    if (selectedMode.value !== 'shots' && activeModel.value?.executable && activeModel.value.modes[0]
      && !activeModel.value.modes.includes(selectedMode.value)) selectedMode.value = activeModel.value.modes[0]
  }

  function selectModelForMode() {
    const mode = selectedMode.value
    if (mode === 'shots' || !status.value || activeModel.value?.modes.includes(mode) && activeModel.value.executable) return
    const candidates = status.value.models.filter(model => model.executable && model.modes.includes(mode))
    const model = candidates.find(item => item.available) ?? candidates[0]
    if (model) selectedModelId.value = model.id
  }

  const commands = useVideoJobCommands({
    route, router, videoStore, submission, observation,
    job, submitting, cancelling, ownsTrackedTask, unboundTaskStatus, statusError, selectedTaskId,
    selectedMode, selectedModelId, aspectRatio, quality, steps, videoAttention, nativeVideo,
    promptSource, parsedSeed, driver, h3Input: h3.input, canGenerate,
    isDisposed: () => disposed,
    isPageActive: () => pageActive,
    getSelectionVersion: () => selectionVersion,
    bumpSelectionVersion: () => ++selectionVersion,
    checkOwner, resolveSubmitFrames, loadStatus, reconnectVideo, retrySelectedJob,
  })
  const { submitVideo, cancelJob } = commands

  // 离开图生视频/首尾帧模式时把「跟随原图」复位，避免文字成片带着 original 画幅被后端 400。
  watch(selectedMode, (mode) => {
    if (mode !== 'image' && mode !== 'first-last-frame' && aspectRatio.value === 'original') aspectRatio.value = 'landscape'
    selectModelForMode()
  })

  let activatedOnce = false
  let initialRestorePending = true

  watch(() => route.path === '/video-studio' && typeof route.query.job === 'string' ? route.query.job : '', id => {
    if (id === selectedTaskId.value) return
    commands.abortSubmit()
    if (id && id !== job.value?.id && id !== submission.request.value?.taskId) detachTrackedBinding?.()
    ownsTrackedTask.value = false
    selectionVersion++
    selectedTaskId.value = id
    reconnectState.value = 'idle'
    selectedJobError.value = ''
    observation.stop()
    if (id) void observation.select()
    else observation.schedule()
  }, { immediate: true, flush: 'sync' })
  watch(() => route.query.mode, mode => { if (route.path === '/video-studio' && mode === 'shots') selectedMode.value = 'shots' })

  function stopPageReads() {
    commands.abortSubmit(true)
    statusRequest?.abort()
    statusRequest = null
    statusLoading.value = false
    observation.stop()
  }
  onDeactivated(() => { pageActive = false; ownsTrackedTask.value = false; selectionVersion++; stopPageReads() })
  onActivated(() => {
    pageActive = true
    if (!activatedOnce) { activatedOnce = true; return }
    if (route.query.mode === 'shots') selectedMode.value = 'shots'
    void (async () => { if (route.query.mode !== 'shots') await consumeVideoCtx(); await restorePreviews() })()
    void loadStatus()
    if (!initialRestorePending && !selectedTaskId.value) void reconnectVideo()
  })

  onMounted(() => {
    // 绘图页「去分镜短片」深链：进入分镜模式并清掉 query（一次性消费）。
    if (route.query.mode === 'shots') {
      selectedMode.value = 'shots'
      void router.replace({ query: { ...route.query, mode: undefined }, hash: route.hash })
    }
    void loadStatus()
    void (async () => {
      const shotsEntry = selectedMode.value === 'shots'
      videoDraftTools.restoreDraft()
      // The shared watcher also saves in shots mode; hydrate single-video fields before it can persist them.
      if (shotsEntry) selectedMode.value = 'shots'
      else await consumeVideoCtx()
      void restorePreviews()
      initialRestorePending = false
      if (disposed || !pageActive) return
      // 新任务按原请求键恢复；旧 ID 仅沿原任务读取。
      if (typeof route.query.job === 'string') return
      await reconnectVideo()
    })()
  })

  const trackedTask = useTrackedTask(() => {
    const current = submitting.value ? null : job.value
    const unconfirmed = requestUnconfirmed.value && (!current || submission.request.value?.taskId === current.id)
    const unknown = unconfirmed || current?.needsReview
    const state = generationTask(submitting.value ? 'submitting' : current?.status || 'idle')
    return {
      kind: 'video', title: '视频创作', backend: current ? { kind: 'video', id: current.id } : undefined,
      route: current ? '/video-studio?job=' + encodeURIComponent(current.id) : '/video-studio',
      resultRoute: current?.resultAvailable ? '/video-studio?job=' + encodeURIComponent(current.id) : undefined,
      status: submitting.value ? 'running' : !current ? unboundTaskStatus.value : unknown ? 'interrupted' : state.taskStatus,
      stage: submitting.value ? 'submitting' : !current || unknown ? 'unknown' : state.stage,
      progress: submitting.value || !current || unknown ? null : progressPercent.value,
      message: current ? current.error || '' : statusFeedback.value,
    }
  }, { cancel: cancelJob }, () => ownsTrackedTask.value)
  detachTrackedBinding = trackedTask?.detachBinding

  onBeforeUnmount(() => {
    disposed = true
    pageActive = false
    ownsTrackedTask.value = false
    commands.dispose()
    stopPageReads()
    stopDraftWatch()
  })

  return {
    chooseModel, driverKind, driver, driverBusy, chooseDriver, clearDriver: () => { driverSource.value = null },
    archiveStatus, archiveState, statusLoading, loadStatus, modes, selectedMode, nativeVideo,
    modeBadge, unsupportedMode, t8State, status, videoImageUrl, clearFirstFrame, hasFirstFrame, hasLastFrame,
    uploadingImage, handleFrameFile, lastFrameUrl, clearLastFrame, prompt, promptMode, promptRecipe, promptPreviewRequest,
    supportsGeneratedAudio, supportsDialogueAndMusic, supportsNegative, aspectOptions,
    aspectRatio, aspectSize, motion, motionOptions,
    quality, qualities, durationOptions, duration, activeModel, steps, nativeH3Steps, h3Steps: h3.steps,
    h3DefaultSteps: h3.defaultSteps, h3Issue, videoAttention, h3LightVae, negative,
    seedText, canGenerate, submitTitle, submitDescription, submitVideo, submitting,
    environmentState, environmentLabel, statusError: statusFeedback, selectedModelId, job, jobStatusLabel,
    formatTime, progressPercent, formatSeconds, progressWarning, jobErrorReport, cancelling,
    cancelJob: () => cancelJob(), cancelOriginalRequest: () => cancelJob(true),
    reconnectState, reconnectVideo, requestPending: requestUnconfirmed,
    jobReading, refreshJob: () => observation.poll(true), jobSelectionPending, selectedJobReading, selectedJobError, retrySelectedJob,
  }
}

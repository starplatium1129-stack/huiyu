import { generationTask, canExecuteVideo } from '@/utils/generationTask'

import { useTrackedTask } from '@/composables/useTaskCenter'
import { useVideoJobObservation } from './useVideoJobObservation'
import { useVideoEnvironment } from './useVideoEnvironment'

import { computed,onBeforeUnmount,onMounted,ref,watch,onActivated,onDeactivated } from 'vue'

import { useRoute,useRouter } from 'vue-router'

import { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'



import { cancelVideoJob, fetchVideoJob, fetchVideoStatus,
  type VideoDefaults, type VideoJob, type VideoMode, type VideoStatusResponse } from '@/api/videoApi'


import { classifySDError } from '@/utils/sdError'

import { useVideoStore } from '@/stores/videoStore'
import { useVideoRequest, videoRequestSettled } from './useVideoRequest'
import { VIDEO_REQUEST_DRAFT_KEY } from '@/utils/storageKeys'
import { sameTempResultOwner, tempResultOwner } from '@/utils/tempResult'
import { flushProfileWrites } from '@/platform/web/profileStorage'
import { onDesktopRuntime } from '@/platform/desktop/runtime'
import { imageMediaSession } from '@/platform/imageMediaSession'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'

import { useVideoFrames } from '@/components/video/useVideoFrames'

import { useVideoStudioDraft } from '@/components/video/useVideoStudioDraft'

/** Owns workspace state and lifecycle; the view only binds presentation. */
export function useVideoWorkspace() {


type StudioMode = VideoMode | 'shots'


const modes: Array<{ id: StudioMode; label: string; ready: boolean; icon: ArchiveIconName }> = [
  { id: 'text', label: '文字成片', ready: true, icon: 'play' },
  { id: 'image', label: '图片动起来', ready: true, icon: 'image' },
  { id: 'first-last-frame', label: '首尾帧过渡', ready: false, icon: 'gallery' },
  { id: 'shots', label: '分镜短片', ready: false, icon: 'gallery' },
]


// H3 readiness controls generation, never access to draft editing or recovery.
const shotsModeReady = computed(() =>
  status.value?.models.some((model) => model.id === 'minimax-h3' && model.available) === true)


// 首尾帧模式门槛：同源 H3（FL2VA 尾帧衔接是 H3 原生节点能力，Wan 5B 无此链路）。
const firstLastFrameReady = computed(() =>
  status.value?.models.some((model) =>
    model.id === 'minimax-h3' && model.available && model.modes.includes('first-last-frame')) === true)


function modeReady(mode: StudioMode): boolean {
  if (mode === 'shots') return true
  if (mode === 'first-last-frame') return firstLastFrameReady.value
  return true
}


function modeBadge(mode: StudioMode): string {
  if (statusLoading.value) return '检测中'
  if (statusReadError.value) return '待重新检测 · 可编辑'
  if (!status.value) return '待检测'
  if (mode !== 'shots' && !status.value.models.some(model => model.modes.includes(mode))) return '当前引擎暂不支持 · 可编辑'
  const modelReady = mode === 'shots' ? shotsModeReady.value
    : status.value.models.some(model => model.available && model.modes.includes(mode))
  if (!modelReady) return modeReady(mode) ? '待装权重 · 可编辑' : '待装权重'
  return status.value.online ? '可生成' : '离线 · 可编辑'
}


const aspectOptions = computed(() => {
  const base: Array<{ id: VideoDefaults['aspectRatio']; label: string }> = [
    { id: 'landscape', label: '横屏' },
    { id: 'portrait', label: '竖屏' },
    { id: 'square', label: '方形' },
  ]
  if (selectedMode.value === 'image' || selectedMode.value === 'first-last-frame') {
    base.push({ id: 'original', label: '跟随原图' })
  }
  return base
})

const activeQuality = computed(() =>
  status.value?.qualities.find(item => item.id === quality.value) ?? null)

const aspectSize = computed(() => (id: string) => {
  if (id === 'original') return '自动匹配'
  return activeQuality.value?.sizes[id] ?? ''
})

const cameraOptions: Array<{ id: VideoDefaults['camera']; label: string }> = [
  { id: 'still', label: '固定镜头 · 最稳' },
  { id: 'push', label: '缓慢推进' },
  { id: 'pull', label: '缓慢拉远' },
  { id: 'pan', label: '平稳横移' },
  { id: 'orbit', label: '轻微环绕' },
]

const motionOptions: Array<{ id: VideoDefaults['motion']; label: string }> = [
  { id: 'subtle', label: '细微运动 · 最稳' },
  { id: 'natural', label: '自然动作' },
  { id: 'expressive', label: '表现动作' },
]

const durationOptions = computed<Array<VideoDefaults['duration']>>(() =>
  activeModel.value?.id === 'minimax-h3' ? [3, 5, 10, 15] : [3, 5])


const selectedMode = ref<StudioMode>('text')

const route = useRoute()

const router = useRouter()

const prompt = ref('')

const negative = ref('')

// 默认选中 H3：主力模型（T8 双时钟加速 / 对白 / 长镜都靠它），Wan 仅作备选。
// 此前默认 wan2.2 导致用户忘记切换就出片（2026-08-17 用户反馈）。
const selectedModelId = ref('minimax-h3')

const aspectRatio = ref<VideoDefaults['aspectRatio']>('landscape')

const quality = ref<VideoDefaults['quality']>('standard')

const steps = ref<4 | 8>(8)

const duration = ref<VideoDefaults['duration']>(3)

const camera = ref<VideoDefaults['camera']>('still')

const motion = ref<VideoDefaults['motion']>('subtle')

const seedText = ref('')

const status = ref<VideoStatusResponse | null>(null)

const statusLoading = ref(false)

const statusError = ref(''), statusReadError = ref('')
const statusFeedback = computed(() => statusError.value || statusReadError.value || recoveryError.value || pollError.value)

const submitting = ref(false)

const cancelling = ref(false)

const job = ref<VideoJob | null>(null)
const ownsTrackedTask = ref(false)
const unboundTaskStatus = ref<'interrupted' | 'failed' | 'cancelled'>('interrupted')
let detachTrackedBinding: (() => void) | undefined
const videoStore = useVideoStore(), submission = useVideoRequest('video', VIDEO_REQUEST_DRAFT_KEY)
const pageOwner = tempResultOwner()
const requestPending = submission.pending, requestUnconfirmed = submission.unconfirmed
const checkOwner = () => { submission.check(); if (!sameTempResultOwner(pageOwner)) throw new Error('视频所属工作区已变化，请回到原连接核对') }

// Route selections and local submissions share ownership; clearing a consumed
// deep link must not count as a newer selection than the submission itself.
const selectedTaskId = ref('')
let selectionVersion = 0

let disposed = false
let pageActive = true
let statusRequest: AbortController | null = null
let submitRequest: AbortController | null = null
let submitSession = imageMediaSession()
function invalidateSubmission() {
  const next = imageMediaSession()
  if (submitSession !== next) { submitSession = next; submitRequest?.abort() }
}
// Keep the command signal current through the journal flush and first POST,
// including the gap after frame preparation has already completed.
const stopSubmitRuntime = onDesktopRuntime(invalidateSubmission)
const stopSubmitSessionWatch = watch(runtimeResourceIdentity, invalidateSubmission, { flush: 'sync' })


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
const { nativeVideo, environmentState, environmentLabel, archiveStatus, archiveState } = useVideoEnvironment({
  status, activeModel, statusLoading, statusReadError, job,
})

const parsedSeed = computed(() => {
  if (!seedText.value.trim()) return undefined
  const value = Number(seedText.value)
  return Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff ? value : null
})

// Only measured progress is determinate; runtime tasks may provide no sample count.
function formatSeconds(total: number) {
  const safe = Math.max(0, Math.round(total))
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return minutes ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`
}

const progressPercent = computed(() => {
  const current = job.value
  if (current?.status === 'succeeded') return 100
  if (!current || current.needsReview || current.status !== 'running' || typeof current.progress !== 'number') return null
  return Math.max(0, Math.min(100, Math.round(current.progress * 100)))
})

/** 运行时间异常预警：超过预估 1.5× 提示、2.5× 判疑似卡死。 */
const progressWarning = computed<{ level: 'warn' | 'danger'; text: string } | null>(() => {
  const current = job.value
  if (!current || current.needsReview || current.status !== 'running' || !current.estimatedSeconds) return null
  const ratio = current.elapsedSeconds / current.estimatedSeconds
  if (ratio >= 2.5) {
    return {
      level: 'danger',
      text: `运行时间异常：已运行 ${formatSeconds(current.elapsedSeconds)}，超过预估 ${formatSeconds(current.estimatedSeconds)} 的 2.5 倍。请查看任务日志，必要时取消任务。`,
    }
  }
  if (ratio >= 1.5) {
    return {
      level: 'warn',
      text: `运行时间异常：已 ${formatSeconds(current.elapsedSeconds)}，预估 ${formatSeconds(current.estimatedSeconds)}。可查看任务日志确认进度。`,
    }
  }
  return null
})

/** T8 双时钟是 H3 专属路径：仅选中 minimax-h3 时展示徽章（Wan 走原生工作流，与 T8 无关）。 */
const t8State = computed(() => {
  if (selectedModelId.value !== 'minimax-h3') return null
  return status.value?.t8 ?? null
})

const canGenerate = computed(() => {
  const mode = selectedMode.value
  // 分镜模式走 ShotListEditor 自己的提交链路，不进单任务生成。
  if (mode === 'shots') return false
  if (mode === 'image' && !hasFirstFrame.value) return false
  if (mode === 'first-last-frame' && !firstFrameReady.value) return false
  return prompt.value.trim().length >= 8
    && prompt.value.length <= 4000
    && parsedSeed.value !== null
    && canExecuteVideo(activeModel.value, mode, status.value?.online === true)
    && !statusLoading.value && !statusReadError.value
    && !submitting.value && !requestPending.value && !videoStore.videoTaskIssue
    && !uploadingImage.value
    && !jobActive.value
    && !job.value?.needsReview
    && reconnectState.value === 'idle'
    && !jobSelectionPending.value && !selectedJobReading.value
})

// 首尾帧模式素材就绪：首帧（绘图页带入 或 本地上传）与尾帧（本地上传）齐备。
const firstFrameReady = computed(() =>
  hasFirstFrame.value && hasLastFrame.value)


const submitTitle = computed(() => {
  if (jobSelectionPending.value || selectedJobReading.value) return selectedJobError.value ? '请先重新读取所选视频任务' : '正在读取所选视频任务'
  if (reconnectState.value !== 'idle') return reconnectState.value === 'reading' ? '正在读取上次视频任务' : '请先重新读取上次任务或到任务中心核对'
  if (job.value?.needsReview) return '请先核对当前视频任务'
  if (jobActive.value) return '已有视频正在生成'
  if (statusLoading.value) return '正在检测视频环境'
  if (statusReadError.value) return '请重新检测视频环境'
  if (activeModel.value && !activeModel.value.executable) return '当前模型暂不支持生成'
  if (!status.value?.online) return nativeVideo.value ? '先准备视频模型与运行环境' : '先启动 ComfyUI'
  if (!activeModel.value?.available) return '先安装本地视频权重'
  if (selectedMode.value !== 'shots' && !activeModel.value.modes.includes(selectedMode.value)) return '当前模型不支持该创作方式'
  if (selectedMode.value === 'first-last-frame' && !firstFrameReady.value) {
    return hasFirstFrame.value ? '先上传一张尾帧图' : '先准备首帧与尾帧图'
  }
  if (selectedMode.value === 'image' && !hasFirstFrame.value) return '先带入一张首帧图'
  if (uploadingImage.value) return '正在准备帧图'
  if (prompt.value.trim().length < 8) return '写下一个完整的镜头'
  if (parsedSeed.value === null) return 'Seed 格式不正确'
  return `${duration.value} 秒 · ${activeModel.value.label} · 本地生成`
})

const submitDescription = computed(() => {
  if (job.value?.needsReview) return '原任务与输入已保留，可重新读取状态或到任务中心核对。'
  if (jobActive.value) return '请等待当前任务完成，或取消任务。'
  if (statusLoading.value) return '正在确认本机连接与可用模型，镜头内容可以继续编辑。'
  if (statusReadError.value) return '请重新检测服务状态。'
  if (activeModel.value && !activeModel.value.executable) return '请在下方更换已支持的模型，当前镜头描述会保留。'
  if (!status.value?.online) return nativeVideo.value ? activeModel.value?.reason || '在控制面板准备原生运行环境后重新检测。' : '在控制面板启动 ComfyUI 后重新检测。'
  if (!activeModel.value?.available) return '请补齐右侧列出的模型文件。'
  return ''
})

const jobStatusLabel = computed(() => job.value?.needsReview ? '状态待核对' : ({
  queued: '排队中',
  running: '生成中',
  cancelling: '取消中',
  succeeded: '已完成',
  failed: '生成失败',
  cancelled: '已取消',
})[job.value?.status || 'queued'])


async function loadStatus() {
  if (disposed || !pageActive) return
  statusRequest?.abort()
  const controller = new AbortController(); statusRequest = controller
  void retrySelectedJob()
  statusLoading.value = true
  try {
    const next = await fetchVideoStatus(controller.signal)
    if (statusRequest !== controller || controller.signal.aborted || disposed) return
    status.value = next; statusReadError.value = ''
    if (!next.models.some(model => model.id === selectedModelId.value)) {
      selectedModelId.value = next.defaults.modelId
    }
    // 图生视频模式下自动落到支持 image 且已就绪的模型（默认 Wan 5B 只能文字成片）。
    if (selectedMode.value === 'image') {
      const current = next.models.find(model => model.id === selectedModelId.value)
      if (!current || !current.modes.includes('image')) {
        const imageReady = next.models.find(model => model.modes.includes('image') && model.available)
        if (imageReady) selectedModelId.value = imageReady.id
      }
    }
  } catch (error) {
    if (statusRequest !== controller || controller.signal.aborted || disposed) return
    statusReadError.value = error instanceof Error ? error.message : '视频环境检测失败'
  } finally {
    if (statusRequest === controller) { statusRequest = null; statusLoading.value = false }
  }
}


// ── 绘图页「出视频」跨页上下文与首帧/尾帧素材（已下沉 useVideoFrames）──────
// 编辑草稿归 useVideoStudioDraft；接收身份与恢复归 useVideoRequest。
const {
  videoImageUrl, lastFrameUrl, uploadingImage, hasFirstFrame, hasLastFrame,
  consumeVideoCtx,
  restorePreviews,
  clearFirstFrame,
  clearLastFrame,
  handleFrameFile,
  resolveSubmitFrames,
} = useVideoFrames({
  selectedMode, aspectRatio, selectedModelId, prompt,
  videoImageId, lastFrameImageId, status, statusError,
  available: () => !disposed && pageActive,
  persistImportedCtx: imageId => videoDraftTools.persistImportedCtx(imageId),
})


const videoDraftTools = useVideoStudioDraft({
  selectedMode, prompt, negative, selectedModelId, aspectRatio, quality,
  steps, duration, camera, motion, seedText,
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
async function reconnectVideo() {
  const previousError = reconnectState.value === 'failed' ? statusError.value : ''
  if (await observation.recover() && previousError && statusError.value === previousError) statusError.value = ''
}


async function submitVideo() {
  if (disposed || !pageActive || !canGenerate.value) return
  const previousJob = job.value
  ownsTrackedTask.value = false
  statusError.value = ''
  submitting.value = true
  job.value = null; unboundTaskStatus.value = 'interrupted'
  observation.stop()
  const selection = ++selectionVersion
  selectedTaskId.value = ''
  if (typeof route.query.job === 'string') void router.replace({ query: { ...route.query, job: undefined }, hash: route.hash })
  ownsTrackedTask.value = true
  const controller = new AbortController()
  submitRequest?.abort(); submitRequest = controller
  try {
    // Only a new explicit generation prepares its input; recovery reads the journal.
    const mode = selectedMode.value
    const request = {
      prompt: prompt.value.trim(),
      negative: negative.value.trim() || undefined,
      modelId: selectedModelId.value,
      aspectRatio: aspectRatio.value,
      duration: duration.value,
      camera: camera.value,
      motion: motion.value,
      seed: typeof parsedSeed.value === 'number' ? parsedSeed.value : undefined,
      quality: quality.value,
      steps: steps.value,
    }
    const frames = await resolveSubmitFrames(mode, controller.signal)
    if (disposed || !pageActive || selection !== selectionVersion) return
    checkOwner()
    if (videoStore.videoTask) {
      if (!videoRequestSettled(previousJob) || previousJob?.id !== videoStore.videoTask.jobId) throw new Error('请先读取并核对旧视频任务')
      videoStore.clearVideoTask(); await flushProfileWrites()
    }
    if (disposed || !pageActive || selection !== selectionVersion) return
    controller.signal.throwIfAborted()
    checkOwner()
    const accepted = await submission.submit({ ...request, ...frames }, controller.signal, undefined, { mode })
    if ('shots' in accepted) throw new Error('视频请求返回了错误的任务类型')
    if (disposed || !pageActive || selection !== selectionVersion) return
    job.value = accepted; pollError.value = ''; recoveryError.value = ''; reconnectState.value = 'idle'
  } catch (error) {
    if (disposed || !pageActive || selection !== selectionVersion) return
    // 按当前引擎给出中文恢复建议，未知错误保留原始消息。
    const report = classifySDError(error, nativeVideo.value ? 'native' : 'comfy')
    const submissionError = report.kind === 'unknown'
      ? (error instanceof Error ? error.message : '视频任务提交失败')
      : `${report.title}：${report.message}`
    if (requestPending.value) reconnectState.value = 'failed'
    else unboundTaskStatus.value = 'failed'
    await loadStatus()
    if (!disposed && pageActive && selection === selectionVersion) statusError.value = requestPending.value ? '原视频接收状态待核对，已阻止重复提交。' + submissionError : submissionError
  } finally {
    if (submitRequest === controller) submitRequest = null
    submitting.value = false
    if (jobSelectionPending.value) void retrySelectedJob()
    else if (pageActive && selection !== selectionVersion && requestUnconfirmed.value) void reconnectVideo()
    else observation.schedule()
  }
}


async function cancelJob(original = false) {
  if (disposed || cancelling.value || !original && (jobSelectionPending.value || selectedJobReading.value)) return
  const preparing = submitRequest
  preparing?.abort()
  if (!job.value && !submission.request.value) {
    if (preparing) {
      selectionVersion++
      unboundTaskStatus.value = 'cancelled'
      statusError.value = '视频准备已停止，尚未提交任务'
    }
    return
  }
  const id = job.value?.id || ''
  const selection = selectionVersion
  // An explicit command can claim this visit; cancelling a different original
  // request cannot make the cached selected clip authoritative.
  if (!original || !job.value || submission.request.value?.taskId === id) ownsTrackedTask.value = true
  cancelling.value = true
  // Cancellation owns the next status; an earlier read cannot turn it back
  // into a running job, and no fresh reads should race the pending command.
  observation.stop()
  try {
    checkOwner()
    const owned = submission.request.value
    const value = owned && (original || !id || owned.taskId === id) ? await submission.cancel() : (await cancelVideoJob(id)).job
    checkOwner()
    if (!disposed && pageActive && selection === selectionVersion) {
      if (value && !('shots' in value) && (!job.value || value.id === job.value.id)) job.value = value
      reconnectState.value = 'idle'; pollError.value = ''; recoveryError.value = ''
      statusError.value = value ? '' : '取消意图已保存，原请求不会再执行'
      if (!value && !job.value) unboundTaskStatus.value = 'cancelled'
    }
  } catch (error) {
    if (!disposed && pageActive && selection === selectionVersion) statusError.value = error instanceof Error ? error.message : '视频任务取消失败'
  } finally {
    cancelling.value = false
    if (jobSelectionPending.value) void retrySelectedJob()
    else if (pageActive && selection !== selectionVersion && requestUnconfirmed.value) void reconnectVideo()
    else observation.schedule()
  }
}


function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(timestamp)
}


// 离开图生视频/首尾帧模式时把「跟随原图」复位，避免文字成片带着 original 画幅被后端 400。
watch(selectedMode, (mode) => {
  if (mode !== 'image' && mode !== 'first-last-frame' && aspectRatio.value === 'original') aspectRatio.value = 'landscape'
})


let activatedOnce = false, initialRestorePending = true

function retrySelectedJob() { return observation.select(true) }
watch(() => route.path === '/video-studio' && typeof route.query.job === 'string' ? route.query.job : '', id => {
  if (id === selectedTaskId.value) return
  submitRequest?.abort()
  if (id && id !== job.value?.id && id !== submission.request.value?.taskId) detachTrackedBinding?.()
  ownsTrackedTask.value = false
  selectionVersion++; selectedTaskId.value = id; reconnectState.value = 'idle'; selectedJobError.value = ''
  observation.stop()
  if (id) void observation.select()
  else observation.schedule()
}, { immediate: true, flush: 'sync' })
watch(() => route.query.mode, mode => { if (route.path === '/video-studio' && mode === 'shots') selectedMode.value = 'shots' })

function stopPageReads() {
  submitRequest?.abort(); submitRequest = null
  statusRequest?.abort(); statusRequest = null; statusLoading.value = false
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
    await restorePreviews()
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
  return { kind: 'video', title: '视频创作', backend: current ? { kind: 'video', id: current.id } : undefined,
    route: current ? '/video-studio?job=' + encodeURIComponent(current.id) : '/video-studio',
    resultRoute: current?.resultAvailable ? '/video-studio?job=' + encodeURIComponent(current.id) : undefined,
    status: submitting.value ? 'running' : !current ? unboundTaskStatus.value : unknown ? 'interrupted' : state.taskStatus,
    stage: submitting.value ? 'submitting' : !current || unknown ? 'unknown' : state.stage,
    progress: submitting.value || !current || unknown ? null : progressPercent.value,
    message: current ? current.error || '' : statusFeedback.value }
}, { cancel: cancelJob }, () => ownsTrackedTask.value)
detachTrackedBinding = trackedTask?.detachBinding

onBeforeUnmount(() => {
  disposed = true
  pageActive = false
  ownsTrackedTask.value = false
  stopSubmitRuntime(); stopSubmitSessionWatch()
  stopPageReads()
  stopDraftWatch()
})
return {
 archiveStatus, archiveState, statusLoading, loadStatus, modes, selectedMode, nativeVideo,
modeReady, modeBadge, t8State, status, videoImageUrl, clearFirstFrame, hasFirstFrame, hasLastFrame,
uploadingImage, handleFrameFile, lastFrameUrl, clearLastFrame, prompt, aspectOptions,
aspectRatio, aspectSize, camera, cameraOptions, motion, motionOptions,
quality, durationOptions, duration, activeModel, steps, negative,
seedText, canGenerate, submitTitle, submitDescription, submitVideo, submitting,
environmentState, environmentLabel, statusError: statusFeedback, selectedModelId, job, jobStatusLabel,
formatTime, progressPercent, formatSeconds, progressWarning, jobErrorReport, cancelling,
cancelJob: () => cancelJob(), cancelOriginalRequest: () => cancelJob(true),
reconnectState, reconnectVideo, requestPending: requestUnconfirmed,
jobReading, refreshJob: () => observation.poll(true), jobSelectionPending, selectedJobReading, selectedJobError, retrySelectedJob,
}
}

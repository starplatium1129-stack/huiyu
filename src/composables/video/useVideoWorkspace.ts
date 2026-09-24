import { generationTask, canExecuteVideo } from '@/utils/generationTask'

import { onActivated } from 'vue'

import { useTrackedTask } from '@/composables/useTaskCenter'
import { useBackendSelection } from '@/composables/tasks/useBackendSelection'

import { computed,onBeforeUnmount,onMounted,ref,watch } from 'vue'

import { useRoute,useRouter } from 'vue-router'

import { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'



import {
cancelVideoJob,
createVideoJob,
fetchVideoJob,
fetchVideoStatus,
type VideoDefaults,
type VideoJob,
type VideoMode,
type VideoStatusResponse,
} from '@/api/videoApi'

import { isLocalStudioHost } from '@/utils/runtimeEnvironment'

import { classifySDError } from '@/utils/sdError'

import { useVideoStore } from '@/stores/videoStore'

import { useVideoFrames } from '@/components/video/useVideoFrames'

import { useVideoStudioDraft } from '@/components/video/useVideoStudioDraft'

/** Owns workspace state and lifecycle; the view only binds presentation. */
export function useVideoWorkspace() {


type StudioMode = VideoMode | 'shots'


const modes: Array<{ id: StudioMode; label: string; description: string; ready: boolean; icon: ArchiveIconName }> = [
  { id: 'text', label: '文字成片', description: '一句镜头描述直接生成短片', ready: true, icon: 'play' },
  { id: 'image', label: '图片动起来', description: '从工作台「生成短片」自动带入首帧，锁定角色与场景', ready: true, icon: 'image' },
  { id: 'first-last-frame', label: '首尾帧过渡', description: '锁定开始与结束画面', ready: false, icon: 'gallery' },
  { id: 'shots', label: '分镜短片', description: '多镜头批量生成 · 自动尾帧衔接 · 整片拼接', ready: false, icon: 'gallery' },
]


// 分镜模式门槛：MiniMax H3 权重就绪（支持 FL2VA 衔接与原生对白）。
const shotsModeReady = computed(() =>
  status.value?.models.some((model) => model.id === 'minimax-h3' && model.available) === true)


// 首尾帧模式门槛：同源 H3（FL2VA 尾帧衔接是 H3 原生节点能力，Wan 5B 无此链路）。
const firstLastFrameReady = computed(() =>
  status.value?.models.some((model) =>
    model.id === 'minimax-h3' && model.available && model.modes.includes('first-last-frame')) === true)


function modeReady(mode: StudioMode): boolean {
  if (mode === 'shots') return shotsModeReady.value
  if (mode === 'first-last-frame') return firstLastFrameReady.value
  return true
}


function modeBadge(mode: StudioMode): string {
  if (statusLoading.value) return '检测中'
  if (!status.value) return '待检测'
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

const statusError = ref('')

const submitting = ref(false)

const cancelling = ref(false)

const job = ref<VideoJob | null>(null)

let pollTimer = 0

let disposed = false


/**
 * 视频任务失败的分类报告（2026-08-30 UX 审计）。
 *
 * 视频后端同样走 ComfyUI，失败时 job.error 是英文技术串。这里复用出图那套
 * 分类器（backend='comfy'）给出中文结论与下一步，原始串留给「技术细节」。
 */
const jobErrorReport = computed(() => {
  const raw = job.value?.error
  if (!raw) return null
  return classifySDError({ message: raw }, 'comfy')
})


// ── 图片动起来（I2VA）状态：首帧来自绘图页「出视频」的跨页上下文 ────────────
const videoImageId = ref('')

const videoImageUrl = ref('')

const uploadingImage = ref(false)


// ── 首尾帧过渡（FL2VA）状态：首帧可来自绘图页或本地上传，尾帧仅本地上传 ────
const firstFrameName = ref('')

const lastFrameName = ref('')

const lastFrameImageId = ref('')

const lastFrameUrl = ref('')


const activeModel = computed(() => status.value?.models.find(model => model.id === selectedModelId.value) || null)

const environmentState = computed(() => {
  if (statusLoading.value) return 'checking'
  if (!status.value?.online) return 'offline'
  if (activeModel.value && !activeModel.value.executable) return 'planned'
  if (activeModel.value?.available) return 'ready'
  return 'missing'
})

const environmentLabel = computed(() => ({
  checking: '检测中',
  offline: 'ComfyUI 离线',
  ready: '可以生成',
  missing: '权重待安装',
  planned: '配方待适配',
})[environmentState.value])

const archiveStatus = computed(() => {
  if (job.value?.status === 'running') return 'RENDERING'
  if (job.value?.status === 'succeeded') return 'CLIP READY'
  return environmentLabel.value.toUpperCase()
})

const archiveState = computed<'idle' | 'active' | 'success' | 'warning'>(() => {
  if (job.value?.status === 'running' || statusLoading.value) return 'active'
  if (job.value?.status === 'succeeded' || environmentState.value === 'ready') return 'success'
  return environmentState.value === 'offline' || environmentState.value === 'missing' ? 'warning' : 'idle'
})

const parsedSeed = computed(() => {
  if (!seedText.value.trim()) return undefined
  const value = Number(seedText.value)
  return Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff ? value : null
})

const jobActive = computed(() => job.value?.status === 'queued'
  || job.value?.status === 'running'
  || job.value?.status === 'cancelling')


// ── 可观测性（2026-08-17）：真实进度外推 + 疑似卡死预警 + T8 状态徽章 ──
function formatSeconds(total: number) {
  const safe = Math.max(0, Math.round(total))
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return minutes ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`
}

const progressPercent = computed(() => {
  const current = job.value
  if (!current) return 0
  return Math.min(100, Math.round((current.progress || 0) * 100))
})

/** 运行时间异常预警：超过预估 1.5× 提示、2.5× 判疑似卡死。 */
const progressWarning = computed<{ level: 'warn' | 'danger'; text: string } | null>(() => {
  const current = job.value
  if (!current || current.status !== 'running' || !current.estimatedSeconds) return null
  const ratio = current.elapsedSeconds / current.estimatedSeconds
  if (ratio >= 2.5) {
    return {
      level: 'danger',
      text: `疑似卡死：已运行 ${formatSeconds(current.elapsedSeconds)}，超过预估 ${formatSeconds(current.estimatedSeconds)} 的 2.5 倍。请检查 ComfyUI（可能卡在模型加载/采样），必要时取消重试。`,
    }
  }
  if (ratio >= 1.5) {
    return {
      level: 'warn',
      text: `运行时间异常：已 ${formatSeconds(current.elapsedSeconds)}，预估 ${formatSeconds(current.estimatedSeconds)}。建议留意 ComfyUI 状态。`,
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
  if (mode === 'image' && !videoImageId.value && !firstFrameName.value) return false
  if (mode === 'first-last-frame' && !firstFrameReady.value) return false
  return prompt.value.trim().length >= 8
    && prompt.value.length <= 4000
    && parsedSeed.value !== null
    && canExecuteVideo(activeModel.value, mode, status.value?.online === true)
    && !submitting.value
    && !uploadingImage.value
    && !jobActive.value
})

// 首尾帧模式素材就绪：首帧（绘图页带入 或 本地上传）与尾帧（本地上传）齐备。
const firstFrameReady = computed(() =>
  Boolean(videoImageId.value || firstFrameName.value) && Boolean(lastFrameImageId.value || lastFrameName.value))


const submitTitle = computed(() => {
  if (jobActive.value) return '已有视频正在生成'
  if (!status.value?.online) return '先启动 ComfyUI'
  if (!activeModel.value?.available) return '先安装本地视频权重'
  if (selectedMode.value === 'first-last-frame' && !firstFrameReady.value) {
    return videoImageId.value || firstFrameName.value ? '先上传一张尾帧图' : '先准备首帧与尾帧图'
  }
  if (selectedMode.value === 'image' && !videoImageId.value && !firstFrameName.value) return '先带入一张首帧图'
  if (uploadingImage.value) return '正在准备帧图'
  if (activeModel.value && selectedMode.value !== 'shots'
    && !activeModel.value.modes?.includes(selectedMode.value as VideoMode)) {
    return selectedMode.value === 'image' ? '当前模型不支持首帧，请在模型目录选择 MiniMax H3' : '当前模型不支持该创作方式'
  }
  if (prompt.value.trim().length < 8) return '写下一个完整的镜头'
  if (parsedSeed.value === null) return 'Seed 格式不正确'
  return `${duration.value} 秒 · ${activeModel.value.label} · 本地生成`
})

const submitDescription = computed(() => {
  if (jobActive.value) return '视频任务耗时较长，为避免显存争抢，当前只允许一个页面任务。'
  if (!status.value?.online) return '控制面板启动 ComfyUI 后，回到这里重新检测即可。'
  if (!activeModel.value?.available) return '页面与原生节点已经就绪，缺失文件会在右侧明确列出。'
  if (selectedMode.value === 'first-last-frame') return '工作室会锁定首尾两帧画面，中间过渡由模型按描述自由发挥。'
  return '工作室会自动补全稳定性约束、帧数、采样器与 MP4 输出设置。'
})

const jobStatusLabel = computed(() => ({
  queued: '排队中',
  running: '生成中',
  cancelling: '取消中',
  succeeded: '已完成',
  failed: '生成失败',
  cancelled: '已取消',
})[job.value?.status || 'queued'])


function schedulePoll() {
  window.clearTimeout(pollTimer)
  if (!job.value || disposed || !jobActive.value) return
  pollTimer = window.setTimeout(() => { void pollJob() }, 1500)
}


async function loadStatus() {
  void taskSelection.retry()
  statusLoading.value = true
  statusError.value = ''
  try {
    const next = await fetchVideoStatus()
    status.value = next
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
    statusError.value = error instanceof Error ? error.message : '视频环境检测失败'
  } finally {
    statusLoading.value = false
  }
}


// ── 绘图页「出视频」跨页上下文与首帧/尾帧素材（已下沉 useVideoFrames）──────
// 草稿持久化与任务重连（F1）归 useVideoStudioDraft。
const {
  consumeVideoCtx,
  clearFirstFrame,
  clearLastFrame,
  handleFrameFile,
  resolveSubmitFrames,
  disposeFrames,
} = useVideoFrames({
  selectedMode, aspectRatio, selectedModelId, prompt,
  videoImageId, videoImageUrl, firstFrameName,
  lastFrameImageId, lastFrameUrl, lastFrameName,
  uploadingImage, status, statusError,
})


const videoDraftTools = useVideoStudioDraft({
  selectedMode, prompt, negative, selectedModelId, aspectRatio, quality,
  steps, duration, camera, motion, seedText,
  videoImageId, lastFrameImageId, videoImageUrl, lastFrameUrl,
  onPersistError: (message) => { statusError.value = message },
})

const stopDraftWatch = videoDraftTools.startDraftWatch()


async function submitVideo() {
  if (!canGenerate.value) return
  submitting.value = true
  try {
    // 帧图解析（受控名优先、IndexedDB 凭据重上传兜底）已下沉 useVideoFrames。
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
      // 成人内容传输层授权：本机直连默认 true，远程/隧道由服务端 fail-closed。
      adultEnabled: isLocalStudioHost(),
    }
    const frames = await resolveSubmitFrames(mode)
    if (disposed) return
    const response = await createVideoJob({ ...request, ...frames })
    job.value = response.job
    // 任务记录（F1）：离页后按 jobId 重连真实状态。
    const recorded = useVideoStore().recordVideoTask({ jobId: response.job.id, mode, submittedAt: Date.now() })
    if (!recorded) {
      statusError.value = '视频任务已提交，但任务记录保存失败；离开本页将无法自动重连，请保留当前页面并重试。'
    }
    schedulePoll()
  } catch (error) {
    // 提交失败多半是 Comfy 侧（显存 / 模型 / 参数），走分类器给中文结论；
    // 分类不出具体原因时仍退回原始消息，不丢信息。
    const report = classifySDError(error, 'comfy')
    const submissionError = report.kind === 'unknown'
      ? (error instanceof Error ? error.message : '视频任务提交失败')
      : `${report.title}：${report.message}`
    await loadStatus()
    statusError.value = submissionError
  } finally {
    submitting.value = false
  }
}


async function pollJob() {
  if (!job.value || !jobActive.value) return
  const id = job.value.id
  try {
    const response = await fetchVideoJob(id)
    if (disposed || job.value?.id !== id) return
    job.value = response.job
  } catch (error) {
    statusError.value = error instanceof Error ? error.message : '视频任务状态读取失败'
  } finally {
    schedulePoll()
  }
}


async function cancelJob() {
  if (!job.value || cancelling.value) return
  const id = job.value.id
  cancelling.value = true
  try {
    const response = await cancelVideoJob(id)
    if (!disposed && job.value?.id === id) job.value = response.job
  } catch (error) {
    statusError.value = error instanceof Error ? error.message : '视频任务取消失败'
  } finally {
    cancelling.value = false
  }
}


function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(timestamp)
}


// 离开图生视频/首尾帧模式时把「跟随原图」复位，避免文字成片带着 original 画幅被后端 400。
watch(selectedMode, (mode) => {
  if (mode !== 'image' && mode !== 'first-last-frame' && aspectRatio.value === 'original') aspectRatio.value = 'landscape'
})


let activatedOnce = false

const taskSelection = useBackendSelection(
  () => route.path === '/video-studio' && typeof route.query.job === 'string' ? route.query.job : '',
  () => job.value?.id,
  fetchVideoJob,
  response => { job.value = response.job; statusError.value = ''; schedulePoll() },
  error => { statusError.value = error instanceof Error ? error.message : '任务读取失败，请重新打开任务重试' },
)
watch(() => route.query.mode, mode => { if (route.path === '/video-studio' && mode === 'shots') selectedMode.value = 'shots' })

onActivated(() => { if (!activatedOnce) { activatedOnce = true; return }; consumeVideoCtx(); if (route.query.mode === 'shots') selectedMode.value = 'shots' })

onMounted(() => {
  // 绘图页「去分镜短片」深链：进入分镜模式并清掉 query（一次性消费）。
  if (route.query.mode === 'shots') {
    selectedMode.value = 'shots'
    void router.replace({ query: { ...route.query, mode: undefined } })
  }
  void loadStatus()
  void (async () => {
    // 草稿先回、跨页上下文后覆盖（F1：ctx 是更新的明确意图，优先级更高）。
    // 分镜模式下草稿由 ShotListEditor 自己的分镜草稿承担，这里跳过。
    if (selectedMode.value !== 'shots') {
      const { firstFrameLost, lastFrameLost } = await videoDraftTools.restoreDraft()
      if (firstFrameLost || lastFrameLost) {
        statusError.value = '草稿已恢复，但部分帧图原文件已失效，请重新选择对应图片'
      }
    }
    consumeVideoCtx()
    // 任务重连（F1）：离页不丢任务——按 jobId 拉回真实状态并恢复轮询。
    if (typeof route.query.job === 'string') return
    const reconnect = await videoDraftTools.reconnectTask()
    if (reconnect.kind === 'job') {
      job.value = reconnect.job
      schedulePoll()
    } else if (reconnect.kind === 'lost') {
      statusError.value = '上次任务已随网关重启中断，结果无法找回；草稿已保留，可重新提交'
    }
  })()
})

useTrackedTask(() => ({ kind: 'video', title: '视频创作', backend: !submitting.value && job.value ? { kind: 'video', id: job.value.id } : undefined, route: job.value ? '/video-studio?job=' + encodeURIComponent(job.value.id) : '/video-studio', resultRoute: job.value?.status === 'succeeded' ? '/video-studio?job=' + encodeURIComponent(job.value.id) : undefined, status: generationTask(submitting.value ? 'submitting' : job.value?.status || 'idle').taskStatus, stage: generationTask(submitting.value ? 'submitting' : job.value?.status || 'idle').stage, progress: progressPercent.value, message: job.value?.error || statusError.value || '' }), { cancel: cancelJob })

onBeforeUnmount(() => {
  disposed = true
  disposeFrames()
  stopDraftWatch()
  window.clearTimeout(pollTimer)
  if (videoImageUrl.value) URL.revokeObjectURL(videoImageUrl.value)
  if (lastFrameUrl.value) URL.revokeObjectURL(lastFrameUrl.value)
})
return {
 archiveStatus, archiveState, statusLoading, loadStatus, modes, selectedMode,
modeReady, modeBadge, t8State, status, videoImageUrl, clearFirstFrame,
uploadingImage, handleFrameFile, lastFrameUrl, clearLastFrame, prompt, aspectOptions,
aspectRatio, aspectSize, camera, cameraOptions, motion, motionOptions,
quality, durationOptions, duration, activeModel, steps, negative,
seedText, canGenerate, submitTitle, submitDescription, submitVideo, submitting,
environmentState, environmentLabel, statusError, selectedModelId, job, jobStatusLabel,
formatTime, progressPercent, formatSeconds, progressWarning, jobErrorReport, cancelling,
cancelJob,
}
}

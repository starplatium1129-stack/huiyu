import { computed, type ComputedRef, type Ref } from 'vue'
import type { DrivingInput, VideoDefaults, VideoDriver, VideoModelStatus, VideoStatusResponse } from '@/api/videoApi'
import { canExecuteVideo } from '@/utils/generationTask'
import type { StudioMode } from './useVideoModeOptions'

export interface VideoSubmitStateDeps {
  selectedMode: Ref<StudioMode>
  hasFirstFrame: Readonly<Ref<boolean>>
  hasLastFrame: Readonly<Ref<boolean>>
  promptContent: ComputedRef<boolean>
  prompt: Ref<string>
  parsedSeed: ComputedRef<number | null | undefined>
  activeModel: ComputedRef<VideoModelStatus | null>
  status: Ref<VideoStatusResponse | null>
  nativeVideo: ComputedRef<boolean>
  unsupportedMode: ComputedRef<boolean>
  h3Issue: ComputedRef<string>
  statusLoading: Ref<boolean>
  statusReadError: Ref<string>
  submitting: Ref<boolean>
  requestPending: ComputedRef<boolean>
  videoTaskIssue: ComputedRef<string>
  uploadingImage: Ref<boolean>
  driverBusy: Ref<boolean>
  driverKind: ComputedRef<DrivingInput | undefined>
  driver: ComputedRef<VideoDriver | null>
  jobActive: ComputedRef<boolean>
  jobNeedsReview: ComputedRef<boolean>
  reconnectState: Ref<'idle' | 'reading' | 'failed'>
  jobSelectionPending: ComputedRef<boolean>
  selectedJobReading: ComputedRef<boolean>
  selectedJobError: Ref<string>
  duration: Ref<VideoDefaults['duration']>
}

export function useVideoSubmitState(deps: VideoSubmitStateDeps) {
  // 首尾帧模式素材就绪：首帧（绘图页带入 或 本地上传）与尾帧（本地上传）齐备。
  const firstFrameReady = computed(() => deps.hasFirstFrame.value && deps.hasLastFrame.value)

  const canGenerate = computed(() => {
    const mode = deps.selectedMode.value
    // 分镜模式走 ShotListEditor 自己的提交链路，不进单任务生成。
    if (mode === 'shots') return false
    if (mode === 'image' && !deps.hasFirstFrame.value) return false
    if (mode === 'first-last-frame' && !firstFrameReady.value) return false
    return deps.promptContent.value
      && deps.prompt.value.length <= 4000
      && deps.parsedSeed.value !== null
      && canExecuteVideo(deps.activeModel.value, mode, deps.status.value?.online === true)
      && !deps.h3Issue.value
      && !deps.statusLoading.value && !deps.statusReadError.value
      && !deps.submitting.value && !deps.requestPending.value && !deps.videoTaskIssue.value
      && !deps.uploadingImage.value
      && !deps.driverBusy.value && (!deps.driverKind.value || !!deps.driver.value)
      && !deps.jobActive.value
      && !deps.jobNeedsReview.value
      && deps.reconnectState.value === 'idle'
      && !deps.jobSelectionPending.value && !deps.selectedJobReading.value
  })

  const submitTitle = computed(() => {
    if (deps.jobSelectionPending.value || deps.selectedJobReading.value) return deps.selectedJobError.value ? '请先重新读取所选视频任务' : '正在读取所选视频任务'
    if (deps.reconnectState.value !== 'idle') return deps.reconnectState.value === 'reading' ? '正在读取上次视频任务' : '请先重新读取上次任务或到任务中心核对'
    if (deps.jobNeedsReview.value) return '请先核对当前视频任务'
    if (deps.jobActive.value) return '已有视频正在生成'
    if (deps.statusLoading.value) return '正在检测视频环境'
    if (deps.statusReadError.value) return '请重新检测视频环境'
    if (deps.unsupportedMode.value) return '当前引擎没有支持此模式的模型'
    if (deps.activeModel.value && !deps.activeModel.value.executable) return '当前模型暂不支持生成'
    if (!deps.status.value?.online) return deps.nativeVideo.value ? '先准备视频模型与运行环境' : '先启动 ComfyUI'
    if (!deps.activeModel.value?.available) return '先安装本地视频权重'
    if (deps.h3Issue.value) return deps.h3Issue.value
    if (deps.selectedMode.value !== 'shots' && !deps.activeModel.value.modes.includes(deps.selectedMode.value)) return '当前模型不支持该创作方式'
    if (deps.selectedMode.value === 'first-last-frame' && !firstFrameReady.value) {
      return deps.hasFirstFrame.value ? '先上传一张尾帧图' : '先准备首帧与尾帧图'
    }
    if (deps.selectedMode.value === 'image' && !deps.hasFirstFrame.value) return '先带入一张首帧图'
    if (deps.driverBusy.value) return '正在准备驱动素材'
    if (deps.driverKind.value && !deps.driver.value) return deps.driverKind.value === 'audio' ? '请选择角色配音 WAV' : '请选择动作参考视频'
    if (deps.uploadingImage.value) return '正在准备帧图'
    if (!deps.promptContent.value) return '选择场景预设、积木或填写镜头描述'
    if (deps.prompt.value.length > 4000) return '请将镜头描述缩短到 4000 字符以内'
    if (deps.parsedSeed.value === null) return 'Seed 格式不正确'
    return `${deps.duration.value} 秒 · ${deps.activeModel.value.label} · 本地生成`
  })

  const submitDescription = computed(() => {
    if (deps.jobNeedsReview.value) return '原任务与输入已保留，可重新读取状态或到任务中心核对。'
    if (deps.jobActive.value) return '请等待当前任务完成，或取消任务。'
    if (deps.statusLoading.value) return '正在确认本机连接与可用模型，镜头内容可以继续编辑。'
    if (deps.statusReadError.value) return '请重新检测服务状态。'
    if (deps.unsupportedMode.value) return '可以先编辑草稿，再到视频引擎设置切换执行路线。'
    if (deps.activeModel.value && !deps.activeModel.value.executable) return '请在下方更换已支持的模型，当前镜头描述会保留。'
    if (!deps.status.value?.online) return deps.nativeVideo.value ? deps.activeModel.value?.reason || '在控制面板准备原生运行环境后重新检测。' : '在控制面板启动 ComfyUI 后重新检测。'
    if (!deps.activeModel.value?.available) return '请补齐右侧列出的模型文件。'
    return ''
  })

  return { firstFrameReady, canGenerate, submitTitle, submitDescription }
}

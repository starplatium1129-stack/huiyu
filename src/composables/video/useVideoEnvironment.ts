import { computed, type Ref } from 'vue'
import type { VideoJob, VideoModelStatus, VideoStatusResponse } from '@/api/videoApi'

/** Readiness belongs to the selected video engine, independently of image services. */
export function useVideoEnvironment(options: {
  status: Ref<VideoStatusResponse | null>
  activeModel: Readonly<Ref<VideoModelStatus | null>>
  statusLoading: Ref<boolean>
  statusReadError: Ref<string>
  job: Ref<VideoJob | null>
}) {
  const { status, activeModel, statusLoading, statusReadError, job } = options
  const nativeVideo = computed(() => status.value?.provider === 'native')
  const environmentState = computed(() => {
    if (statusLoading.value) return 'checking'
    if (statusReadError.value) return 'unconfirmed'
    if (!nativeVideo.value && !status.value?.online) return 'offline'
    if (activeModel.value && !activeModel.value.executable) return 'planned'
    if (activeModel.value?.available) return 'ready'
    return 'missing'
  })
  const environmentLabel = computed(() => ({
    checking: '检测中', unconfirmed: '状态待确认', offline: 'ComfyUI 离线',
    ready: '可以生成', missing: nativeVideo.value ? '模型与环境待准备' : '权重待安装',
    planned: '配方待适配',
  })[environmentState.value])
  const archiveStatus = computed(() => {
    if (job.value?.status === 'running') return '生成中'
    if (job.value?.status === 'succeeded') return '成片已就绪'
    return environmentLabel.value
  })
  const archiveState = computed<'idle' | 'active' | 'success' | 'warning'>(() => {
    if (job.value?.status === 'running' || statusLoading.value) return 'active'
    if (job.value?.status === 'succeeded' || environmentState.value === 'ready') return 'success'
    return environmentState.value === 'offline' || environmentState.value === 'missing' ? 'warning' : 'idle'
  })
  return { nativeVideo, environmentState, environmentLabel, archiveStatus, archiveState }
}

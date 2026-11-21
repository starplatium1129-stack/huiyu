import { computed, type Ref } from 'vue'
import type { VideoDefaults, VideoMode, VideoModelStatus, VideoStatusResponse } from '@/api/videoApi'
import type { ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'

export type StudioMode = VideoMode | 'shots'

export function useVideoModeOptions(
  status: Ref<VideoStatusResponse | null>, statusLoading: Ref<boolean>, statusReadError: Ref<string>,
  selectedMode: Ref<StudioMode>, quality: Ref<VideoDefaults['quality']>, activeModel: Readonly<Ref<VideoModelStatus | null>>,
) {
  const modes: Array<{ id: StudioMode; label: string; icon: ArchiveIconName }> = [
    { id: 'text', label: '文字成片', icon: 'play' },
    { id: 'image', label: '图片动起来', icon: 'image' },
    { id: 'first-last-frame', label: '首尾帧过渡', icon: 'gallery' },
    { id: 'shots', label: '分镜短片', icon: 'gallery' },
  ]

  const motionOptions: Array<{ id: VideoDefaults['motion']; label: string }> = [
    { id: 'subtle', label: '细微运动 · 最稳' },
    { id: 'natural', label: '自然动作' },
    { id: 'expressive', label: '表现动作' },
  ]

  // H3 readiness controls generation, never access to draft editing or recovery.
  const shotsModeReady = computed(() =>
    status.value?.provider !== 'native' && status.value?.models.some((model) => model.id === 'minimax-h3' && model.available) === true)

  const unsupportedMode = computed(() => {
    const mode = selectedMode.value
    return mode !== 'shots' && !!status.value && !status.value.models.some(model => model.executable && model.modes.includes(mode))
  })

  const modeBadge = computed(() => {
    const mode = selectedMode.value
    if (statusLoading.value) return '检测中 · 可编辑'
    if (statusReadError.value) return '待重新检测 · 可编辑'
    if (!status.value) return '待检测'
    if (mode === 'shots' && status.value.provider === 'native') return 'ComfyUI 分镜 · 可编辑'
    if (unsupportedMode.value) return '当前引擎暂不支持 · 可编辑'
    const modelReady = mode === 'shots' ? shotsModeReady.value
      : status.value.models.some(model => model.executable && model.available && model.modes.includes(mode))
    if (!modelReady) return '待装权重 · 可编辑'
    return status.value.online ? '可生成' : '离线 · 可编辑'
  })


  const aspectOptions = computed(() => {
    const base: Array<{ id: VideoDefaults['aspectRatio']; label: string }> = [
      { id: 'landscape', label: '横屏' },
      { id: 'portrait', label: '竖屏' },
      { id: 'square', label: '方形' },
    ]
    if (activeModel.value?.canvases) return base.filter(option => activeModel.value?.canvases?.[option.id])
    if (selectedMode.value === 'image' || selectedMode.value === 'first-last-frame') {
      base.push({ id: 'original', label: '跟随原图' })
    }
    return base
  })

  const qualities = computed(() => (status.value?.qualities ?? []).filter(item =>
    !activeModel.value?.qualities || activeModel.value.qualities.includes(item.id)))
  const activeQuality = computed(() => qualities.value.find(item => item.id === quality.value))

  const aspectSize = computed(() => (id: string) => {
    if (id === 'original') return '自动匹配'
    const canvas = activeModel.value?.canvases?.[id]
    if (canvas) return canvas.join(' × ')
    return activeQuality.value?.sizes[id] ?? ''
  })

  const durationOptions = computed<Array<VideoDefaults['duration']>>(() =>
    activeModel.value?.durations ?? (activeModel.value?.id === 'minimax-h3' ? [3, 5, 10, 15] : [3, 5]))
  return { modes, modeBadge, unsupportedMode, aspectOptions, aspectSize, motionOptions, durationOptions, qualities }
}

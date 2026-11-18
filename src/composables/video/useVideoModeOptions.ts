import { computed, type Ref } from 'vue'
import type { VideoDefaults, VideoMode, VideoModelStatus, VideoStatusResponse } from '@/api/videoApi'
import type { ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'

export type StudioMode = VideoMode | 'shots'

export function useVideoModeOptions(
  status: Ref<VideoStatusResponse | null>, statusLoading: Ref<boolean>, statusReadError: Ref<string>,
  selectedMode: Ref<StudioMode>, quality: Ref<VideoDefaults['quality']>, activeModel: Readonly<Ref<VideoModelStatus | null>>,
) {
  const modes: Array<{ id: StudioMode; label: string; ready: boolean; icon: ArchiveIconName }> = [
    { id: 'text', label: '文字成片', ready: true, icon: 'play' },
    { id: 'image', label: '图片动起来', ready: true, icon: 'image' },
    { id: 'first-last-frame', label: '首尾帧过渡', ready: false, icon: 'gallery' },
    { id: 'shots', label: '分镜短片', ready: false, icon: 'gallery' },
  ]


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

  const durationOptions = computed<Array<VideoDefaults['duration']>>(() =>
    activeModel.value?.id === 'minimax-h3' ? [3, 5, 10, 15] : [3, 5])
  return { modes, modeReady, modeBadge, aspectOptions, aspectSize, cameraOptions, motionOptions, durationOptions }
}

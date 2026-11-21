import library from '../../../runtime-rs/src/video/prompt-library.json'
import { videoVisualSlots, type VideoPromptMode, type VideoPromptRecipe, type VideoVisualSlot } from '../../../types/videoPrompt'
import type { ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import type { SceneRating } from '@/types/api'

interface PromptOption {
  label: string
  modes?: readonly VideoPromptMode[]
}

export interface VideoPromptPreset {
  id: string
  title: string
  rating?: SceneRating
  summary: string
  icon: ArchiveIconName
  recipe: VideoPromptRecipe
}

const slots = library.slots as Record<VideoVisualSlot, PromptOption & { options: Record<string, PromptOption & { zh: string }> }>
export const videoPromptPresets = library.presets as Record<VideoPromptMode, readonly VideoPromptPreset[]>
export const videoPresetRatings = [
  { value: 'all', label: '全部分级' },
  { value: 'All', label: '全年龄' },
  { value: 'R15', label: 'R15' },
  { value: 'R18', label: 'R18' },
]
export function matchesVideoPresetRating(preset: Pick<VideoPromptPreset, 'rating'>, filter: string | number) {
  return filter === 'all' || (preset.rating ?? 'All') === filter
}
export const videoSoundOptions = [
  { value: '', label: '随场景' },
  ...Object.entries(library.sounds).map(([value, option]) => ({ value, label: option.label })),
]
export const videoMusicOptions = [
  { value: '', label: '随描述' },
  ...Object.entries(library.music).map(([value, option]) => ({ value, label: option.label })),
]

export const videoPromptGuidance: Record<VideoPromptMode, string> = {
  text: '交代谁在什么地方，再写一个清楚的动作和收尾。',
  image: '从首帧接着写，描述接下来怎么动。',
  'first-last-frame': '写清姿态、机位或光线怎么从首帧过渡到尾帧。',
  'motion-driver': '动作由参考视频决定。可以补充光影、画风和神态。',
  'voice-driver': '口型跟随配音。可以补充说话时的情绪、眼神和光影。',
}

function supportsMode(option: PromptOption, mode: VideoPromptMode) {
  return !option.modes || option.modes.includes(mode)
}

export function videoPromptGroups(mode: VideoPromptMode) {
  return videoVisualSlots.filter(slot => supportsMode(slots[slot], mode)).map(slot => ({
    slot,
    label: slot === 'action' && mode.endsWith('-driver') ? '神态'
      : slot === 'action' && mode === 'first-last-frame' ? '过渡动作'
      : slots[slot].label,
    options: [
      { value: '', label: slot === 'camera' ? '自动' : '未选' },
      ...Object.entries(slots[slot].options).filter(([, option]) => supportsMode(option, mode))
        .map(([value, option]) => ({ value, label: option.label })),
    ],
  }))
}

export function hasVideoPromptContent(mode: VideoPromptMode, recipe: VideoPromptRecipe, description: string) {
  const slotsWithContent: readonly VideoVisualSlot[] = mode === 'text' ? ['subject', 'action', 'atmosphere']
    : ['action', 'camera', 'atmosphere', 'ending']
  return !!description.trim() || slotsWithContent.some(slot => {
    const id = recipe[slot]
    const option = id && slots[slot].options[id]
    return !!option && supportsMode(slots[slot], mode) && supportsMode(option, mode)
  })
}

export function videoPromptBlockText(recipe: VideoPromptRecipe, slot: VideoVisualSlot) {
  return slots[slot].options[recipe[slot] ?? '']?.zh ?? ''
}

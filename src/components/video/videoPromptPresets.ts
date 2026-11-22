import library from '../../../runtime-rs/src/video/prompt-library.json'
import { videoVisualSlots, type VideoPromptMode, type VideoPromptRecipe, type VideoVisualSlot } from '../../../types/videoPrompt'
import type { ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import type { SceneRating } from '@/types/api'

export type VideoPresetCategory = keyof typeof library.presetCategories
export type VideoActionMotion = 'subtle' | 'natural' | 'expressive'

interface PromptOption {
  label: string
  modes?: readonly VideoPromptMode[]
  rating?: SceneRating
  motion?: VideoActionMotion
  zh?: string
}

export interface VideoPromptPreset {
  id: string
  title: string
  category: VideoPresetCategory
  rating?: SceneRating
  summary: string
  icon: ArchiveIconName
  recipe: VideoPromptRecipe
}

export interface VideoAudioChoice {
  value: string
  label: string
  text: string
}

export interface VideoRecipeSummaryItem {
  key: string
  slot?: VideoVisualSlot
  audioKey?: 'sound' | 'music' | 'dialogue'
  slotLabel: string
  label: string
}

export const videoPresetCategories = library.presetCategories as Record<VideoPresetCategory, string>

const slots = library.slots as Record<VideoVisualSlot, PromptOption & { options: Record<string, PromptOption & { zh: string }> }>
const sounds = library.sounds as Record<string, { label: string; zh: string }>
const musicMap = library.music as Record<string, { label: string; zh: string }>

export const videoPromptPresets = library.presets as Record<VideoPromptMode, readonly VideoPromptPreset[]>
export const videoPresetRatings = [
  { value: 'all', label: '全部分级' },
  { value: 'All', label: '全年龄' },
  { value: 'R15', label: 'R15' },
  { value: 'R18', label: 'R18' },
]

const RATING_ORDER: Record<SceneRating, number> = { All: 0, R15: 1, R18: 2 }

export function matchesVideoPresetRating(preset: Pick<VideoPromptPreset, 'rating'>, filter: string | number) {
  return filter === 'all' || (preset.rating ?? 'All') === filter
}

function matchesBlockRating(option: Pick<PromptOption, 'rating'>, filter: string | number) {
  if (filter === 'all') return true
  const max = filter === 'R18' ? RATING_ORDER.R18 : filter === 'R15' ? RATING_ORDER.R15 : RATING_ORDER.All
  return RATING_ORDER[option.rating ?? 'All'] <= max
}

export function presetCategoriesFor(mode: VideoPromptMode, rating: string | number = 'all') {
  const present = new Set(
    videoPromptPresets[mode]
      .filter(preset => matchesVideoPresetRating(preset, rating))
      .map(preset => preset.category),
  )
  return [
    { id: 'all' as const, label: '全部' },
    ...(Object.entries(videoPresetCategories) as [VideoPresetCategory, string][])
      .filter(([id]) => present.has(id))
      .map(([id, label]) => ({ id, label })),
  ]
}

export const videoSoundChoices: readonly VideoAudioChoice[] = [
  { value: '', label: '随场景', text: '按镜头描述与场景自动匹配环境声。' },
  ...Object.entries(sounds).map(([value, option]) => ({ value, label: option.label, text: option.zh })),
]

export const videoMusicChoices: readonly VideoAudioChoice[] = [
  { value: '', label: '随描述', text: '按镜头情绪自动匹配或由文字决定。' },
  ...Object.entries(musicMap).map(([value, option]) => ({ value, label: option.label, text: option.zh })),
]

export const videoSoundOptions = videoSoundChoices.map(({ value, label }) => ({ value, label }))
export const videoMusicOptions = videoMusicChoices.map(({ value, label }) => ({ value, label }))

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

function slotDisplayLabel(slot: VideoVisualSlot, mode: VideoPromptMode) {
  if (slot === 'action' && mode.endsWith('-driver')) return '神态'
  if (slot === 'action' && mode === 'first-last-frame') return '过渡动作'
  return slots[slot].label
}

export function videoPromptGroups(
  mode: VideoPromptMode,
  ratingFilter: string | number = 'all',
  currentRecipe?: VideoPromptRecipe,
) {
  return videoVisualSlots.filter(slot => supportsMode(slots[slot], mode)).map(slot => ({
    slot,
    label: slotDisplayLabel(slot, mode),
    options: [
      { value: '', label: slot === 'camera' ? '自动' : '未选', text: '', rating: undefined as SceneRating | undefined },
      ...Object.entries(slots[slot].options)
        .filter(([value, option]) => supportsMode(option, mode)
          && (matchesBlockRating(option, ratingFilter) || currentRecipe?.[slot] === value))
        .map(([value, option]) => ({ value, label: option.label, text: option.zh, rating: option.rating })),
    ],
  }))
}

export function summarizeVideoRecipe(
  mode: VideoPromptMode,
  recipe: VideoPromptRecipe,
  supportsAudio: boolean,
  supportsDialogueAndMusic: boolean,
): { items: VideoRecipeSummaryItem[]; prose: string } {
  const items: VideoRecipeSummaryItem[] = []
  const sentences: string[] = []
  for (const slot of videoVisualSlots) {
    const id = recipe[slot]
    const option = id ? slots[slot].options[id] : undefined
    if (!option || !supportsMode(slots[slot], mode) || !supportsMode(option, mode)) continue
    items.push({ key: slot, slot, slotLabel: slotDisplayLabel(slot, mode), label: option.label })
    if (option.zh) sentences.push(option.zh)
  }
  if (supportsAudio && recipe.audio) {
    const sound = recipe.audio.sound ? sounds[recipe.audio.sound] : undefined
    if (sound && recipe.audio.sound) {
      items.push({ key: 'audio:sound', audioKey: 'sound', slotLabel: '声景', label: sound.label })
      sentences.push(sound.zh)
    }
    if (supportsDialogueAndMusic) {
      const music = recipe.audio.music ? musicMap[recipe.audio.music] : undefined
      if (music && recipe.audio.music) {
        items.push({ key: 'audio:music', audioKey: 'music', slotLabel: '配乐', label: music.label })
        sentences.push(music.zh)
      }
      const dialogue = recipe.audio.dialogue?.trim()
      if (dialogue) {
        const preview = dialogue.length > 16 ? `${dialogue.slice(0, 16)}…` : dialogue
        items.push({ key: 'audio:dialogue', audioKey: 'dialogue', slotLabel: '对白', label: preview })
        sentences.push(`对白：「${dialogue}」`)
      }
    }
  }
  return { items, prose: sentences.join('') }
}

export function pickRandomVideoPreset(
  mode: VideoPromptMode,
  ratingFilter: string | number = 'all',
  categoryFilter: 'all' | VideoPresetCategory = 'all',
  currentPresetId?: string,
): VideoPromptPreset | null {
  const byRating = videoPromptPresets[mode].filter(preset => matchesVideoPresetRating(preset, ratingFilter))
  const byCategory = categoryFilter === 'all' ? byRating : byRating.filter(preset => preset.category === categoryFilter)
  const pool = byCategory.length ? byCategory : byRating.length ? byRating : videoPromptPresets[mode]
  if (!pool.length) return null
  const candidates = pool.length > 1 && currentPresetId
    ? pool.filter(preset => preset.id !== currentPresetId)
    : pool
  return candidates[Math.floor(Math.random() * candidates.length)] ?? pool[0] ?? null
}

export function videoActionMotion(actionId?: string): VideoActionMotion {
  const option = actionId ? slots.action.options[actionId] : undefined
  return option?.motion ?? 'natural'
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

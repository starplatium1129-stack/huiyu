import type { VideoDefaults } from '@/api/videoApi'
import {
  videoActionMotion, videoPromptBlockText, videoPromptPresets as library,
  type VideoPromptPreset,
} from './videoPromptPresets'

export { videoPromptGuidance } from './videoPromptPresets'
export type ShotPromptMode = 'text' | 'image'

export interface VideoPromptFields {
  setup: string
  action: string
  atmosphere: string
  ending: string
}

export interface VideoPromptEdit {
  prompt: string
  camera: VideoDefaults['camera']
  motion: VideoDefaults['motion']
}

const SHOT_CAMERAS = new Set<VideoDefaults['camera']>(['still', 'push', 'pull', 'pan', 'orbit'])

export function toShotCamera(camera?: string): VideoDefaults['camera'] {
  if (camera && SHOT_CAMERAS.has(camera as VideoDefaults['camera'])) return camera as VideoDefaults['camera']
  if (camera === 'follow') return 'pan'
  return 'still'
}

function sceneStarter({ recipe, id, title, category, icon, rating }: VideoPromptPreset) {
  const extraCamera = recipe.camera && !SHOT_CAMERAS.has(recipe.camera as VideoDefaults['camera']) && recipe.camera !== 'follow'
    ? videoPromptBlockText(recipe, 'camera')
    : ''
  const action = [videoPromptBlockText(recipe, 'action'), extraCamera].filter(Boolean).join('')
  return {
    id, title, category, icon, rating,
    fields: {
      setup: videoPromptBlockText(recipe, 'subject'),
      action,
      atmosphere: videoPromptBlockText(recipe, 'atmosphere'),
      ending: videoPromptBlockText(recipe, 'ending'),
    },
    camera: toShotCamera(recipe.camera),
    motion: videoActionMotion(recipe.action),
  }
}

export const videoPromptPresets: Record<ShotPromptMode, ReadonlyArray<ReturnType<typeof sceneStarter>>> = {
  text: library.text.map(sceneStarter),
  image: library.image.map(sceneStarter),
}

export function blankVideoPromptFields(): VideoPromptFields {
  return { setup: '', action: '', atmosphere: '', ending: '' }
}

export function assembleVideoPrompt(mode: ShotPromptMode, fields: VideoPromptFields): string {
  return [mode === 'text' ? fields.setup : '', fields.action, fields.atmosphere, fields.ending]
    .map(part => part.trim())
    .filter(Boolean)
    .join('\n')
}

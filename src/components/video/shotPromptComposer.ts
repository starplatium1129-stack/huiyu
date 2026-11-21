import type { VideoDefaults } from '@/api/videoApi'
import { videoPromptBlockText, videoPromptPresets as library, type VideoPromptPreset } from './videoPromptPresets'

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

const smallActions = new Set(['swaying-lantern', 'blink', 'breeze', 'forehead-touch', 'robe-edge', 'profile-light'])

function sceneStarter({ recipe, id, title, icon, rating }: VideoPromptPreset) {
  return {
    id, title, icon, rating,
    fields: {
      setup: videoPromptBlockText(recipe, 'subject'),
      action: videoPromptBlockText(recipe, 'action'),
      atmosphere: videoPromptBlockText(recipe, 'atmosphere'),
      ending: videoPromptBlockText(recipe, 'ending'),
    },
    camera: (recipe.camera || 'still') as VideoDefaults['camera'],
    motion: smallActions.has(recipe.action ?? '') ? 'subtle' as const : 'natural' as const,
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

export const videoPromptModes = ['text', 'image', 'first-last-frame', 'motion-driver', 'voice-driver'] as const
export type VideoPromptMode = typeof videoPromptModes[number]
export type VideoInputMode = Exclude<VideoPromptMode, 'motion-driver' | 'voice-driver'>

export const videoVisualSlots = ['framing', 'subject', 'action', 'camera', 'atmosphere', 'ending'] as const
export type VideoVisualSlot = typeof videoVisualSlots[number]

export interface VideoPromptAudio {
  sound?: string
  music?: string
  dialogue?: string
  language?: 'zh' | 'en' | 'ja'
}

export type VideoPromptRecipe = Partial<Record<VideoVisualSlot, string>> & { audio?: VideoPromptAudio }
export type VideoPromptDrafts = Partial<Record<VideoPromptMode, VideoPromptRecipe>>

export interface VideoPromptSource {
  prompt: string
  promptRecipe: VideoPromptRecipe
  negative?: string
  modelId: string
  duration: number
  camera: string
  motion: string
}

export interface VideoPromptPreviewRequest extends VideoPromptSource {
  mode: VideoInputMode
}

export interface VideoPromptPreview {
  prompt: string
  negative?: string
}

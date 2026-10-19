export const MAX_ANIMA_REGIONS = 4
export const ANIMA_REGION_PROMPT_LIMIT = 1200
export const ANIMA_SKETCH_MAX_BYTES = 16 * 1024 * 1024

export interface AnimaSketchControl {
  image: string
  strength: number
  start: number
  end: number
}
export interface AnimaPromptRegion {
  id: string
  prompt: string
  x: number
  y: number
  width: number
  height: number
}
export interface AnimaCompositionRequest {
  sketchControl?: AnimaSketchControl
  regions?: AnimaPromptRegion[]
}
export interface AnimaCompositionCapabilities {
  regionalPrompting?: boolean
  sketchControl?: boolean
  sketchControlStatus?: { available: boolean; reason?: string; file?: string; source?: string }
}
export type AnimaRegionPreset = 'left' | 'right' | 'top' | 'bottom' | 'center'

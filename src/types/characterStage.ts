import type { CharacterConfig } from '@/config/characters'
import type { StageSurface } from '@/composables/chat/useStageFraming'
import type { Live2DBackendKind } from '@/live2d/types'

export interface CharacterStageProps {
  activeId: string
  surface?: StageSurface
  suspended?: boolean
  character: CharacterConfig
  speaking: boolean
  chatStatusText: string
  statusKind: string
  autoLoad: boolean
  presence?: string
  desktopWindowBounds?: { x: number; y: number; width: number; height: number } | null
  outfit: string
  volume?: number
  /** auto reads the desktop dataset or URL, falling back to the browser backend. */
  backend?: Live2DBackendKind | 'auto'
}

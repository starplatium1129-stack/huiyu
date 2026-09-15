export type AnimaPhase = 'idle' | 'submitting' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled'

export interface AnimaJobMetadata {
  engine: 'anima' | 'krea2'
  id: string
  prompt: string
  negative: string
  profileId: string
  modelId: string
  loraId: string | null
  loraStrength: number | null
  loras?: Array<{ id: string; strength: number }>
  styleLoraId?: string | null
  width: number
  height: number
  steps: number
  cfg: number
  sampler: string
  scheduler: string
  seed: number
  character: 'nene' | 'natsume' | 'triad' | null
  preview?: boolean
  hiresFix?: boolean
  hiresScale?: number
  hiresDenoise?: number
  teaCache?: boolean
  teaCacheThresh?: number
  initImage?: string | null
  maskImage?: string | null
  maskPrompt?: string | null
  denoisingStrength?: number
  growMaskBy?: number
  createdAt: number
  resultUrl: string | null
}

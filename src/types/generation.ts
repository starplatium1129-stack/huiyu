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

export interface GenerationJob {
  id: string
  /** Raw nonempty wire status. Use generationTask for UI stages, including unknown. */
  status: string
  provider: 'comfy' | 'webui'
  /**
   * Comfy 路径的真实执行进度（0–1，来自 ComfyUI ws 步骤事件；generation.js
   * 的 Comfy 分支复用 anima 服务，进度桥已在后端就位）。WebUI 路径与未知
   * 进度为 null——此时 UI 应走 indeterminate 兜底，而非假装 0%。
   */
  progress?: number | null
  /** 后端组装的进度文案（如「采样 12 / 30 · 节点 10」），Comfy 路径才有。 */
  progressText?: string | null
  /** 当前执行中的 ComfyUI 节点号。 */
  currentNode?: string | null
  /** 任务已运行秒数（服务端时钟）。 */
  elapsedSeconds?: number
  seed?: number | null
  resultAvailable?: boolean
  resultUrl?: string | null
  metadata?: Record<string, unknown> & { seed?: number; provider?: string }
  error?: string | null
  code?: string | null
}

export interface GenerationStatus {
  ok: boolean
  online: boolean
  provider: string | null
  webuiOnline: boolean
  comfyFallbackOnline: boolean
  checkpoint: string
  samplers: string[]
  schedulers: string[]
  models: string[]
  loras: Array<{ id: string; character: string; available: boolean }>
  capabilities: {
    basic: boolean
    hires: boolean
    hiresUpscalers: string[]
    faceDetailer: boolean
  }
  pending: number
  maxPending: number
}

export interface GenerationJobEnvelope {
  ok: boolean
  job: GenerationJob
}

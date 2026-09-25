import type { ApiClient } from '@/api/client'
import type { AnimaGenerationState, AnimaJobMetadata, AnimaOption, AnimaResult, AnimaResultContext } from '@/types/anima'
import type { CharKey } from '@/stores/promptBuilderStore'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'

export interface AnimaPublicJob {
  id: string
  status: 'queued' | AnimaGenerationState['phase']
  progress?: number | null
  elapsedSeconds?: number
  progressText?: string
  currentNode?: string | null
  seed: number
  resultAvailable: boolean
  resultUrl: string | null
  metadata?: AnimaJobMetadata
  error: string | null
  code: string | null
}

export interface AnimaStatusResponse {
  ok?: boolean
  online?: boolean
  models?: AnimaOption[]
  loras?: AnimaOption[]
  styleLoras?: AnimaGenerationState['styleLoras']
  error?: string
}

export interface AnimaRequest {
  prompt: string
  negative: string
  profileId: string
  modelId: string
  loraId: string | null
  loraStrength: number | null
  width: number
  height: number
  steps: number
  cfg: number
  seed?: number
  character: 'nene' | 'natsume' | 'triad' | null
  styleLoraId?: string
  hiresFix?: boolean
  hiresScale?: number
  hiresDenoise?: number
  teaCache?: boolean
  teaCacheThresh?: number
  initImage?: string
  maskImage?: string
  maskPrompt?: string
  maskThreshold?: number
  denoisingStrength?: number
  growMaskBy?: number
  adultEnabled?: boolean
}

export interface AnimaSessionOptions {
  getCharacter: () => CharKey
  isPopular: () => boolean
  getFamily: () => 'anima' | 'krea2'
  getRequest: () => AnimaRequest | null
  getSubmitContext?: () => AnimaResultContext | null
  onResult: (result: AnimaResult) => void
  flash: (message: string) => void
  preferredSize: () => string
  client?: ApiClient
}

export const ANIMA_LORA_BY_CHARACTER = {
  nene: 'L_NENE_V21_ANIMA',
  natsume: 'L_NAT_V21_ANIMA',
} as const

export const ANIMA_CHARACTER_BY_CHARACTER = {
  nene: 'nene',
  natsume: 'natsume',
} as const

export type InpaintCharacterMode = 'nene' | 'natsume' | 'none' | null

export interface InpaintRequestBinding {
  character: 'nene' | 'natsume' | null
  loraId: string | null
  modelId: string
  width: number
  height: number
}

export function jobPath(family: 'anima' | 'krea2', id?: string): string {
  const base = family === 'krea2' ? '/api/creative/jobs' : '/api/anima/jobs'
  return id ? `${base}/${encodeURIComponent(id)}` : base
}

export function resolveInpaintRequestBinding(
  models: AnimaOption[],
  currentModelId: string,
  character: InpaintCharacterMode,
  desiredSize: string,
): InpaintRequestBinding | null {
  const usesCharacterLora = character === 'nene' || character === 'natsume'
  const currentModel = models.find(model => model.id === currentModelId)
  const selectedModel = usesCharacterLora
    ? currentModel
    : currentModel?.capabilities?.noLora === true
      ? currentModel
      : models.find(model => model.capabilities?.noLora === true)
  if (!selectedModel || (!usesCharacterLora && selectedModel.capabilities?.noLora !== true)) return null

  const outputSize = closestSupportedSize(selectedModel, desiredSize)
  const [width, height] = outputSize.split('x').map(Number)
  return {
    character: usesCharacterLora ? character : null,
    loraId: usesCharacterLora ? ANIMA_LORA_BY_CHARACTER[character] : null,
    modelId: selectedModel.id,
    width,
    height,
  }
}

/** Request payloads are constrained to the server whitelist; empty fields are omitted. */
export function animaRequestPayload(
  request: AnimaRequest,
): Omit<AnimaRequest, 'profileId' | 'loraId' | 'loraStrength'> & Partial<Pick<AnimaRequest, 'loraId' | 'loraStrength'>> & { adultEnabled?: boolean } {
  const adultEnabled = request.adultEnabled !== undefined ? request.adultEnabled : isLocalStudioHost()
  return {
    prompt: request.prompt,
    negative: request.negative,
    modelId: request.modelId,
    ...(request.loraId ? { loraId: request.loraId, loraStrength: request.loraStrength } : {}),
    ...(request.styleLoraId ? { styleLoraId: request.styleLoraId } : {}),
    width: request.width,
    height: request.height,
    steps: request.steps,
    cfg: request.cfg,
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    character: request.character,
    ...(request.hiresFix ? {
      hiresFix: true,
      hiresScale: request.hiresScale || 2.0,
      hiresDenoise: request.hiresDenoise || 0.35,
    } : {}),
    ...(request.teaCache !== undefined ? { teaCache: request.teaCache } : {}),
    ...(request.teaCacheThresh !== undefined ? { teaCacheThresh: request.teaCacheThresh } : {}),
    ...(request.initImage ? { initImage: request.initImage } : {}),
    ...(request.maskImage ? { maskImage: request.maskImage } : {}),
    ...(request.maskPrompt ? { maskPrompt: request.maskPrompt } : {}),
    ...(request.maskPrompt && request.maskThreshold !== undefined ? { maskThreshold: request.maskThreshold } : {}),
    ...(request.denoisingStrength !== undefined ? { denoisingStrength: request.denoisingStrength } : {}),
    ...(request.growMaskBy !== undefined ? { growMaskBy: request.growMaskBy } : {}),
    ...(adultEnabled ? { adultEnabled: true } : {}),
  }
}

/** If a desired size is unsupported, converge to the closest supported aspect ratio. */
export function closestSupportedSize(
  model: { sizes?: ReadonlyArray<string> | string[] } | undefined,
  desired: string,
): string {
  const sizes = model?.sizes || []
  if (!sizes.length || sizes.includes(desired)) return desired
  const [desiredWidth, desiredHeight] = desired.split('x').map(Number)
  if (!desiredWidth || !desiredHeight) return sizes[0]
  const desiredRatio = desiredWidth / desiredHeight
  return [...sizes].sort((left, right) => {
    const [leftWidth, leftHeight] = left.split('x').map(Number)
    const [rightWidth, rightHeight] = right.split('x').map(Number)
    return Math.abs(leftWidth / leftHeight - desiredRatio) - Math.abs(rightWidth / rightHeight - desiredRatio)
  })[0]
}

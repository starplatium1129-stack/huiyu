import { isMossAcceleration, validMossSpectrumFlexWindow } from '@/config/directImageModels'
import type { ArtworkRecord } from '@/types/artwork'

function mossExecution(runtime: unknown): Record<string, unknown> | undefined {
  if (!runtime || typeof runtime !== 'object' || !('mossExecution' in runtime)) return
  const execution = runtime.mossExecution
  if (execution && typeof execution === 'object') return execution as Record<string, unknown>
}

export function effectiveMossWeightPrecision(runtime: unknown): 'int8' | 'fp16' | undefined {
  const weights = mossExecution(runtime)?.weightPrecision
  if (weights === 'int8-convrot') return 'int8'
  if (weights === 'fp16') return weights
}

export function effectiveMossTextPrecision(runtime: unknown) {
  const precision = mossExecution(runtime)?.textPrecision
  if (precision === 'int8' || precision === 'fp8' || precision === 'bf16') return precision
}

export function mossArtworkMetadata(input: Record<string, unknown>, sceneTitle: string): Partial<ArtworkRecord> {
  if (input.mossUpscaleScale === 1.5 || input.mossUpscaleScale === 2) {
    return {
      mossUpscaleScale: input.mossUpscaleScale,
      ...(typeof input.mossUpscaleSourceTaskId === 'string' ? { mossUpscaleSourceTaskId: input.mossUpscaleSourceTaskId } : {}),
      upscaler: 'Remacri',
      sceneTitle: `${sceneTitle} · Remacri ${input.mossUpscaleScale}×`,
    }
  }
  const effectiveWeight = effectiveMossWeightPrecision(input.nativeRuntime)
  const effectiveText = effectiveMossTextPrecision(input.nativeRuntime)
  return {
    mossSampler: input.mossSampler === 'er-sde' || input.sampler === 'er-sde' ? 'er-sde' : 'euler',
    mossAcceleration: isMossAcceleration(input.mossAcceleration) ? input.mossAcceleration : 'off',
    ...(validMossSpectrumFlexWindow(input.mossSpectrumFlexWindow) ? { mossSpectrumFlexWindow: input.mossSpectrumFlexWindow } : {}),
    mossTextPrecision: input.mossTextPrecision === 'auto' || input.mossTextPrecision === 'int8' || input.mossTextPrecision === 'fp8' ? input.mossTextPrecision : 'bf16',
    ...(effectiveText ? { mossEffectiveTextPrecision: effectiveText } : {}),
    mossCompile: input.mossCompile === true,
    mossWeightPrecision: input.mossWeightPrecision === 'int8' ? 'int8' : input.mossWeightPrecision === 'auto' ? 'auto' : 'fp16',
    ...(effectiveWeight ? { mossEffectiveWeightPrecision: effectiveWeight } : {}),
  }
}

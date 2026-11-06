import { validMossSpectrumFlexWindow } from '@/config/directImageModels'
import type { ArtworkRecord } from '@/types/artwork'

export function mossArtworkMetadata(input: Record<string, unknown>, sceneTitle: string): Partial<ArtworkRecord> {
  if (input.mossUpscaleScale === 1.5 || input.mossUpscaleScale === 2) {
    return {
      mossUpscaleScale: input.mossUpscaleScale,
      ...(typeof input.mossUpscaleSourceTaskId === 'string' ? { mossUpscaleSourceTaskId: input.mossUpscaleSourceTaskId } : {}),
      upscaler: 'Remacri',
      sceneTitle: `${sceneTitle} · Remacri ${input.mossUpscaleScale}×`,
    }
  }
  return {
    mossAcceleration: input.mossAcceleration === 'spectrum' ? 'spectrum' : 'off',
    ...(validMossSpectrumFlexWindow(input.mossSpectrumFlexWindow) ? { mossSpectrumFlexWindow: input.mossSpectrumFlexWindow } : {}),
    mossTextPrecision: input.mossTextPrecision === 'int8' ? 'int8' : input.mossTextPrecision === 'fp8' ? 'fp8' : 'bf16',
    mossCompile: input.mossCompile === true,
    mossWeightPrecision: input.mossWeightPrecision === 'int8' ? 'int8' : input.mossWeightPrecision === 'auto' ? 'auto' : 'fp16',
  }
}

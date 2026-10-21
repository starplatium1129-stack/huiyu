import type { AnimaJobMetadata, AnimaResultContext } from '@/types/anima'
import type { GeneratedArtworkInput } from './artworkSaveInput'

/** Automatic, manual and restored direct results preserve the same frozen recipe.
 * A runtime task ID still selects authoritative task archival, never another upload. */
export function captureAnimaArtworkInput(
  result: { blob: Blob; metadata: AnimaJobMetadata },
  context: AnimaResultContext | null,
  fallback: Pick<GeneratedArtworkInput, 'story' | 'scene'>,
  taskId?: string,
): GeneratedArtworkInput {
  const metadata = JSON.parse(JSON.stringify(result.metadata)) as AnimaJobMetadata
  const frozen = context ? JSON.parse(JSON.stringify(context)) as AnimaResultContext : null
  return {
    blob: result.blob,
    taskId,
    context: frozen,
    prompt: metadata.prompt,
    negative: metadata.negative ?? '',
    seed: metadata.seed,
    engine: metadata.engine,
    provider: metadata.provider,
    profile: metadata.profileId,
    model: metadata.modelId,
    lora: metadata.loraId,
    loraId: metadata.loraId,
    loraStrength: metadata.loraStrength,
    noLora: !metadata.loraId,
    loras: metadata.loras,
    styleLoraId: metadata.styleLoraId ?? null,
    preview: metadata.preview === true,
    cfg: metadata.cfg,
    steps: metadata.steps,
    sampler: metadata.sampler,
    scheduler: metadata.scheduler,
    size: `${metadata.width}x${metadata.height}`,
    hiresFix: metadata.hiresFix === true,
    hiresScale: typeof metadata.hiresScale === 'number' ? metadata.hiresScale : undefined,
    hiresDenoise: typeof metadata.hiresDenoise === 'number' ? metadata.hiresDenoise : undefined,
    hiresUpscaler: metadata.hiresUpscaler ?? undefined,
    hiresSteps: metadata.hiresSteps,
    faceDetailer: metadata.faceDetailer,
    sketchControl: metadata.sketchControl,
    sketchControlModel: metadata.sketchControlModel,
    regions: metadata.regions,
    story: frozen?.story ?? fallback.story,
    scene: frozen ? frozen.sceneId ?? null : fallback.scene,
    parentId: frozen?.parentId,
  }
}

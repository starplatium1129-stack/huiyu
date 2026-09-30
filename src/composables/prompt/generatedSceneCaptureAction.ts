import type { AnimaResult, AnimaResultContext } from '@/types/anima'
import type { HistorySnapshot } from '@/types/promptHistory'
import { historyFromResultContext } from '@/utils/resultContext'
import { runtimeFetch } from '@/platform/runtimeUrl'

export interface CapturedSceneFacts {
  context: AnimaResultContext
  meta?: AnimaResult['metadata']
  prompt: string
}

/** Loaded only when the user creates a scene from a completed image. */
export async function loadGeneratedSceneCapture(facts: CapturedSceneFacts, url: string,
  signal: AbortSignal, image?: Blob): Promise<{ recipe: HistorySnapshot; image: Blob } | null> {
  if (signal.aborted) return null
  const { context, meta, prompt } = facts
  const recipe: HistorySnapshot = {
    ...historyFromResultContext(context),
    ...(meta ? {
      engine: meta.engine, model: meta.modelId, profile: meta.profileId,
      seed: meta.seed, prompt: meta.prompt, negative: meta.negative,
      cfg: meta.cfg, steps: meta.steps, sampler: meta.sampler, scheduler: meta.scheduler,
      width: meta.width, height: meta.height, size: `${meta.width}x${meta.height}`,
      lora: meta.loraId, loraId: meta.loraId, loraStrength: meta.loraStrength,
      loras: meta.loras, styleLoraId: meta.styleLoraId,
      hiresFix: meta.hiresFix, hiresScale: meta.hiresScale, hiresDenoise: meta.hiresDenoise,
    } : { engine: 'sd', prompt }),
  }
  if (!image) {
    const response = await runtimeFetch(url, { signal })
    if (!response.ok) throw new Error('读取成片失败，请重试')
    image = await response.blob()
  }
  if (signal.aborted) return null
  if (!image.size || !image.type.startsWith('image/')) throw new Error('成片图片已失效')
  return { recipe, image }
}

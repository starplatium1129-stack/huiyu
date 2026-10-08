import type { Ref } from 'vue'
import type { AnimaRequest } from '@/composables/generation/animaSessionContract'
import type { DrawEngine } from '@/storage/settingsRepository'
import type { RecipeSnapshot } from '@/utils/recipeComparison'

export interface RecipePreviewContext {
  engine: Ref<DrawEngine>
  animaRequest(): AnimaRequest | null
}
/** Read the same compiler/request builder as submission, without changing the form or contacting a provider. */
export function previewRecipeSubmission(context: RecipePreviewContext): RecipeSnapshot | null {
  if (context.engine.value === 'sd') return null
  const request = context.animaRequest()
  if (!request) return null
  return { engine: context.engine.value, model: request.modelId, size: `${request.width}x${request.height}`, seed: request.seed ?? -1,
    steps: request.steps, cfg: request.cfg, sampler: '底模默认', scheduler: '底模默认', lora: request.loraId ? `${request.loraId}${request.loraStrength == null ? '' : `:${request.loraStrength}`}` : null,
    styleLoraId: request.styleLoraId || null, hiresFix: Boolean(request.hiresFix), hiresScale: request.hiresScale ?? null,
    hiresDenoise: request.hiresDenoise ?? null, faceDetailer: false, prompt: request.prompt, negative: request.negative }
}

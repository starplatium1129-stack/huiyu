import type { Ref } from 'vue'
import type { AnimaRequest } from '@/composables/generation/animaSessionContract'
import type { SDQueueJob } from '@/composables/generation/useSDQueue'
import type { DrawEngine } from '@/storage/settingsRepository'
import type { RecipeSnapshot } from '@/utils/recipeComparison'
import { buildTxt2ImgRequest } from '@/utils/sdRequest'
import { buildRuntimeSdInput } from '@/utils/sdRuntimeRequest'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { sdJobRequest } from './sdJobRequest'

export interface RecipePreviewContext {
  engine: Ref<DrawEngine>
  sdJob(): Omit<SDQueueJob, 'id'> | null
  animaRequest(): AnimaRequest | null
}
/** Read the same compiler/request builder as submission, without changing the form or contacting a provider. */
export function previewRecipeSubmission(context: RecipePreviewContext): RecipeSnapshot | null {
  if (context.engine.value === 'sd') {
    const job = context.sdJob()
    if (!job) return null
    const params = sdJobRequest(job)
    const { payload } = buildTxt2ImgRequest(params)
    const input = buildRuntimeSdInput(params, payload, isLocalStudioHost())
    return { engine: 'sd', model: input.modelId || '后端当前底模', size: `${input.width}x${input.height}`, seed: input.seed,
      steps: input.steps, cfg: input.cfg, sampler: input.sampler, scheduler: input.scheduler || null,
      lora: input.loras.length ? input.loras.map(item => `${item.id}:${item.strength}`).join(', ') : null,
      styleLoraId: null, hiresFix: input.hiresFix, hiresScale: input.hiresScale ?? null,
      hiresDenoise: input.denoisingStrength ?? null, faceDetailer: input.faceDetailer,
      prompt: input.prompt, negative: input.negative }
  }
  const request = context.animaRequest()
  if (!request) return null
  return { engine: context.engine.value, model: request.modelId, size: `${request.width}x${request.height}`, seed: request.seed ?? -1,
    steps: request.steps, cfg: request.cfg, sampler: '底模默认', scheduler: '底模默认', lora: request.loraId ? `${request.loraId}${request.loraStrength == null ? '' : `:${request.loraStrength}`}` : null,
    styleLoraId: request.styleLoraId || null, hiresFix: Boolean(request.hiresFix), hiresScale: request.hiresScale ?? null,
    hiresDenoise: request.hiresDenoise ?? null, faceDetailer: false, prompt: request.prompt, negative: request.negative }
}

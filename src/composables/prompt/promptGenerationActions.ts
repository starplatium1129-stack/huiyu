import type { Ref } from 'vue'
import type { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import type { useDirectorEngine } from '@/composables/scene/useDirectorEngine'
import type { useDirectorPopular } from '@/composables/scene/useDirectorPopular'
import type { useAnimaSession } from '@/composables/generation/useAnimaSession'
import { ANIMA_HIRES_PRESET, type AnimaPixelUpscaler } from '@/config/animaHires'
import { apiClient } from '@/api/client'
import type { AnimaResult, AnimaResultContext } from '@/types/anima'
export interface PromptGenerationContext extends
  Pick<ReturnType<typeof useDirectorEngine>, 'generationBusy'>,
  Pick<ReturnType<typeof useDirectorPopular>, 'applyManagedRoute'> {
  pb: ReturnType<typeof usePromptBuilderStore>
  livePrompt: Readonly<Ref<string>>
  generateAnima: ReturnType<typeof useAnimaSession>['generate']
}
type Context = PromptGenerationContext
export interface HiresSource {
  anima: ReturnType<ReturnType<typeof useAnimaSession>['resultSubmission']>
  result: AnimaResult
  context: AnimaResultContext | null
}
export async function callGenerateAction(ctx: Context): Promise<void> {
  if (ctx.generationBusy.value) return
  if (ctx.pb.directorMode === 'basic') await ctx.applyManagedRoute({ silent: true })
  if (!ctx.livePrompt.value) { ctx.pb.flash('请先选择场景或填写故事'); return }
  await ctx.generateAnima()
}
export async function prepareResultUpscale(source: HiresSource, method: AnimaPixelUpscaler, signal: AbortSignal) {
  const { blob, metadata } = source.result
  const recipe = source.anima?.request ?? metadata
  if (!recipe.prompt || !recipe.modelId || !Number.isSafeInteger(recipe.seed) || recipe.seed! < 0
    || !Number.isInteger(recipe.steps) || recipe.steps < 1 || !Number.isFinite(recipe.cfg)) {
    throw new Error('当前成片缺少原始采样配方，请先重新出图')
  }
  const bitmap = await createImageBitmap(blob)
  const { width, height } = bitmap
  bitmap.close()
  signal.throwIfAborted()
  const uploaded = await apiClient.request<{ ok: boolean; name: string }>('/api/anima/images/raw', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob, signal, timeoutMs: 30_000,
  })
  if (!uploaded.ok || !uploaded.name) throw new Error('放大原图上传失败')
  return {
    family: 'anima' as const,
    context: source.anima?.context ?? source.context,
    request: {
      prompt: recipe.prompt, negative: recipe.negative, modelId: recipe.modelId, profileId: recipe.profileId,
      loraId: recipe.loraId, loraStrength: recipe.loraStrength, character: recipe.character,
      width, height, steps: recipe.steps, cfg: recipe.cfg, seed: recipe.seed,
      ...ANIMA_HIRES_PRESET, hiresUpscaler: method, hiresOnly: true, initImage: uploaded.name, teaCache: false,
    },
  }
}

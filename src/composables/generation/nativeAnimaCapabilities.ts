import type { AnimaOption } from '@/types/anima'
import type { AnimaRequest } from './animaSessionContract'

/** Built-in strategy ships with the worker; no per-recipe files to prepare. */
export function nativeTeaCacheReady(model: AnimaOption | null | undefined): boolean {
  return model?.capabilities?.teaCache === true && model.teaCacheProfile?.readiness === 'builtin'
}

export function nativeAnimaRequestBlocker(models: AnimaOption[], request: Partial<AnimaRequest>): string | null {
  const model = models.find(model => model.id === request.modelId)
  if (request.hiresFix && model?.capabilities?.hires !== true) return '所选原生模型暂不支持高清修复，请先在生成参数中关闭此选项。'
  if (request.hiresFix && request.hiresUpscaler === 'Remacri' && !model?.capabilities?.hiresUpscalers?.includes('Remacri')) {
    return 'Remacri 文件未就绪，请先准备独立模型文件，或明确选择 Auto / Latent。'
  }
  if (request.teaCache && !nativeTeaCacheReady(model)) {
    return '当前原生运行时尚未提供内置 TeaCache，请更新运行时，或暂时关闭特征缓存加速。'
  }
  return null
}

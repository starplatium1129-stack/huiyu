import type { AnimaOption } from '@/types/anima'
import type { AnimaRequest } from './animaSessionContract'

/** File discovery only; the worker verifies calibration against the actual job. */
export function nativeTeaCacheReady(model: AnimaOption | null | undefined): boolean {
  return model?.capabilities?.teaCache === true && model.teaCacheProfile?.readiness === 'profile-files-only'
}

export function nativeAnimaRequestBlocker(models: AnimaOption[], request: Partial<AnimaRequest>): string | null {
  const model = models.find(model => model.id === request.modelId)
  if (request.hiresFix && model?.capabilities?.hires !== true) return '所选原生模型暂不支持高清修复，请先在生成参数中关闭此选项。'
  if (request.hiresFix && request.hiresUpscaler === 'Remacri' && !model?.capabilities?.hiresUpscalers?.includes('Remacri')) {
    return 'Remacri 文件未就绪，请先准备独立模型文件，或明确选择 Auto / Latent。'
  }
  if (request.teaCacheThresh !== undefined) return '原生 TeaCache 不沿用已保存的数值阈值，请在生成参数中选择“使用本地校准档阈值”。'
  if (request.teaCache && !nativeTeaCacheReady(model)) {
    return 'TeaCache 缺少所选模型的本地 teacache-profile.json 校准档，请先准备文件，或在生成参数中关闭 TeaCache。'
  }
  return null
}

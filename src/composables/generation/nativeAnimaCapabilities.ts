import type { AnimaOption } from '@/types/anima'
import type { AnimaRequest } from './animaSessionContract'

/** File discovery only; the worker verifies calibration against the actual job. */
export function nativeTeaCacheReady(model: AnimaOption | null | undefined): boolean {
  return model?.capabilities?.teaCache === true && model.teaCacheProfile?.readiness === 'profile-files-only'
}

export function nativeAnimaRequestBlocker(models: AnimaOption[], request: Partial<AnimaRequest>): string | null {
  if (request.hiresFix) return '原生推理暂不支持高清修复，请先在生成参数中关闭此选项。'
  if (request.teaCacheThresh !== undefined) return '原生 TeaCache 不沿用已保存的数值阈值，请在生成参数中选择“使用本地校准档阈值”。'
  if (request.teaCache && !nativeTeaCacheReady(models.find(model => model.id === request.modelId))) {
    return 'TeaCache 缺少所选模型的本地 teacache-profile.json 校准档，请先准备文件，或在生成参数中关闭 TeaCache。'
  }
  return null
}

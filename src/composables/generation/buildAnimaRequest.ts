import type { AnimaGenerationState } from '@/types/anima'
import type { CharKey } from '@/types/promptHistory'
import type { DrawSubject } from '@/utils/popularContent'
import type { ModelProfile } from '@/utils/promptPolicy'
import { resolveDrawCapabilities } from '@/utils/drawCapabilities'
import { endfieldAnimaBinding } from '@/utils/loraCatalog'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { ANIMA_LORA_BY_CHARACTER, ANIMA_CHARACTER_BY_CHARACTER, type AnimaRequest } from './animaSessionContract'

export interface BuildAnimaRequestInput {
  subject: DrawSubject; char: CharKey; state: AnimaGenerationState
  profile: ModelProfile | null; prompt: string; negative: string
}

/** Workbench and companion share model/profile/character admission; chat never supplies these bindings. */
export function buildAnimaRequest(input: BuildAnimaRequestInput): AnimaRequest {
  const { subject, char, state, profile } = input
  if (!profile || profile.engine !== state.family || profile.model_id !== state.modelId) throw new Error('当前底模没有匹配的模型 profile，已拒绝生成')
  const selected = state.models.find(model => model.id === state.modelId)
  const capabilities = resolveDrawCapabilities(state.family, profile, selected?.capabilities ?? null)
  const popular = subject.kind === 'popular'
  if (!popular && char === 'triad' && !capabilities.dualCharacter) throw new Error('当前绘图路径暂不支持旧双角色配置，请重新选择单个角色')
  const settings = {
    prompt: input.prompt, negative: input.negative, profileId: profile.id || '', modelId: state.modelId,
    width: state.width, height: state.height, steps: state.steps, cfg: state.cfg,
    ...(state.seed == null ? {} : { seed: state.seed }),
    ...(state.family === 'krea2' && state.styleLoraId ? { styleLoraId: state.styleLoraId } : {}),
    hiresFix: Boolean(state.hiresFix), hiresScale: state.hiresScale, hiresDenoise: state.hiresDenoise, hiresUpscaler: state.hiresUpscaler,
    teaCache: state.provider === 'native' ? state.teaCache : state.teaCache !== false, teaCacheThresh: state.teaCacheThresh,
    adultEnabled: isLocalStudioHost(),
  }
  if (popular) {
    if (!capabilities.noLora) throw new Error('当前底模不支持无 LoRA 热门角色创作')
    const binding = endfieldAnimaBinding(subject.characterId, state.family, state.modelId)
    if (!binding && endfieldAnimaBinding(subject.characterId, state.family)) throw new Error('当前底模不兼容终末地角色 LoRA，请选择标准 Anima 底模')
    if (binding && !state.loras.some(lora => lora.id === binding.loraId && lora.available !== false)) throw new Error('终末地角色 LoRA 尚未安装，请先准备模型文件')
    return { ...settings, loraId: binding?.loraId ?? null, loraStrength: binding ? state.loraStrength : null, character: binding?.character ?? null }
  }
  const charKey = char === 'triad' ? null : char
  const expected = charKey ? ANIMA_LORA_BY_CHARACTER[charKey] : ''
  if (capabilities.lora && capabilities.characterIdentity && charKey
    && (state.loraId !== expected || !state.loras.some(lora => lora.id === expected && lora.available !== false))) throw new Error('角色 LoRA 尚未从服务端白名单发现，请先准备模型文件')
  return { ...settings, loraId: capabilities.lora ? state.loraId : null, loraStrength: capabilities.lora ? state.loraStrength : null,
    character: capabilities.characterIdentity && charKey ? ANIMA_CHARACTER_BY_CHARACTER[charKey] : null }
}

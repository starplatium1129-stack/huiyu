import type { UseDirectorPopularInput } from './useDirectorPopular'
import { parseGeneratedRecipe } from '@/utils/generatedSceneDraft'
import type { AnimaGenerationState } from '@/types/anima'
import { endfieldAnimaBinding } from '@/utils/loraCatalog'

/** Apply the recorded engine before its settings; unsupported resources are reported explicitly. */
export function applyGeneratedSceneSettings(value: unknown, input: UseDirectorPopularInput): string[] {
  const recipe = parseGeneratedRecipe(value)
  input.pb.randomVariation = null
  const { pb, sd, animaState, patchAnimaState, setDrawEngine, applyModel } = input
  const parameters = recipe.parameters
  const notes: string[] = []
  const character = parameters.characterId || parameters.character
  if (!pb.isPopular && (character === 'nene' || character === 'natsume' || character === 'triad')) pb.setChar(character)
  setDrawEngine(recipe.engine, { silent: true })
  if (input.drawEngine.value !== recipe.engine) return ['原引擎当前不可用，请先选择支持的角色与引擎']
  // The saved prompt already contains the original manual input. Leaving a previous
  // scene's extra layers here would silently add different clothes/actions on reuse.
  pb.manualTags = new Set()
  pb.outfitOverride = null
  pb.visualDescription = ''
  pb.selections.emotion = [...(parameters.emotion || [])]
  pb.setShot(parameters.shot || null)
  pb.setLighting(parameters.lighting || null)
  pb.setComposition(parameters.composition || null)
  pb.setColorMood(parameters.colorMood || null)
  pb.sdParams.negativeCustom = ''
  pb.sdParams.negative = !!recipe.negative
  pb.markParamTouched('negative')
  const number = (value: unknown) => value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : undefined
  const modelId = parameters.model || parameters.checkpoint
  const savedSize = parameters.size?.replace('×', 'x')
  const size = savedSize && /^\d{3,4}x\d{3,4}$/.test(savedSize)
    && savedSize.split('x').every(part => Number(part) >= 512 && Number(part) <= 4096 && Number(part) % 8 === 0) ? savedSize : undefined
  if (savedSize && !size) notes.push('原画幅记录无效，保留当前画幅')
  if (recipe.engine === 'sd') {
    if (modelId && (sd.models.value.includes(modelId) || sd.checkpoint.value === modelId)) {
      pb.sdModelName = modelId
      pb.applyModelProfile(modelId, { applySize: false })
    } else notes.push(modelId ? `原底模 ${modelId} 当前不可用，保留当前底模` : '未记录底模，保留当前底模')
    if (size) { input.sdSize.value = size; pb.sdParams.size = size; pb.markParamTouched('size') }
    for (const key of ['cfg', 'steps', 'hiresScale', 'hiresSteps', 'hiresDenoise'] as const) {
      const value = number(parameters[key])
      if (value !== undefined) { pb.sdParams[key] = value; pb.markParamTouched(key) }
    }
    for (const key of ['sampler', 'scheduler', 'hiresUpscaler'] as const) {
      if (typeof parameters[key] === 'string') { pb.sdParams[key] = parameters[key]; pb.markParamTouched(key) }
    }
    for (const key of ['hiresFix', 'faceDetailer'] as const) {
      if (typeof parameters[key] === 'boolean') { pb.sdParams[key] = parameters[key]; pb.markParamTouched(key) }
    }
    const seed = number(parameters.seed)
    if (seed !== undefined) { pb.sdParams.seed = seed; pb.sdParams.seedLock = seed >= 0; pb.markParamTouched('seed'); pb.markParamTouched('seedLock') }
  } else {
    const model = animaState.value.models.find(item => item.id === modelId && item.family === recipe.engine && item.available !== false)
    if (modelId) {
      // applyModel records ownership of defaults, so the status refresh cannot reset a valid restored model's parameters.
      applyModel(modelId)
      if (!model) notes.push(`原底模 ${modelId} 尚未确认可用，请核对后生成`)
    } else notes.push('未记录底模，保留当前底模')
    const patch: Partial<AnimaGenerationState> = { family: recipe.engine, styleLoraId: '' }
    if (size) {
      const [width, height] = size.split('x').map(Number)
      if (model?.sizes?.length && !model.sizes.includes(size)) notes.push(`原画幅 ${size} 不受当前底模支持，请调整后生成`)
      patch.width = width; patch.height = height
    }
    for (const key of ['cfg', 'steps', 'hiresScale', 'hiresDenoise', 'loraStrength'] as const) {
      const value = number(parameters[key]); if (value !== undefined) patch[key] = value
    }
    for (const key of ['sampler', 'scheduler'] as const) if (typeof parameters[key] === 'string') patch[key] = parameters[key]
    if (typeof parameters.hiresFix === 'boolean') patch.hiresFix = parameters.hiresFix
    const seed = number(parameters.seed); if (seed !== undefined) patch.seed = seed >= 0 ? seed : null
    const binding = endfieldAnimaBinding(pb.isPopular && pb.subject.kind === 'popular' ? pb.subject.characterId : null, recipe.engine, patch.modelId ?? animaState.value.modelId)
    const loraId = pb.isPopular ? binding?.loraId : parameters.loraId
    if (recipe.engine === 'anima' && loraId) {
      patch.loraId = loraId
      if (binding && parameters.loraStrength === undefined) patch.loraStrength = binding.loraStrength
      if (!animaState.value.loras.some(lora => lora.id === loraId && lora.available !== false)) notes.push('原角色 LoRA 尚未确认可用，请核对后生成')
    } else patch.loraId = ''
    if (recipe.engine === 'krea2' && parameters.styleLoraId) {
      patch.styleLoraId = parameters.styleLoraId
      if (!animaState.value.styleLoras.some(lora => lora.id === parameters.styleLoraId && lora.available)) notes.push('原风格 LoRA 尚未确认可用，请核对后生成')
    }
    patchAnimaState(patch)
  }
  pb.setArtistStyleIds([...(parameters.artistStyleIds || [])])
  notes.push('提示词将按当前规则重新编译，画面可能与原图不同')
  return notes
}

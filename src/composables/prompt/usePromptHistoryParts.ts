import type { ArtworkRecord } from '@/types/artwork'
import type { HistoryRecipeParts } from '@/types/historyReuse'
import { parseHistoryRecipe } from '@/utils/historyRecipe'
import { snapshotHistoricalRecipe } from '@/utils/recipeComparison'
import { findBlueprint } from '@/utils/popularContent'
import type { PromptHistoryApplyDeps } from './usePromptHistoryApply'

/** Selective reuse keeps the current subject, engine and album. Never injects the compiled historical prompt. */
export async function applyHistoryParts(deps: PromptHistoryApplyDeps, record: ArtworkRecord, parts: HistoryRecipeParts, isCurrent = () => true) {
  const { pb, animaState, patchAnimaState, refreshAnimaBackend, sdSize } = deps
  const parsed = parseHistoryRecipe(record)
  if (!parsed.ok) return false
  const { recipe: entry, notes } = parsed
  const engine = deps.drawEngine.value
  const sameEngine = entry.engine === engine
  const popular = entry.subject === 'popular' || Boolean(entry.noLora && entry.characterId)
  const sameSubject = popular
    ? pb.subject.kind === 'popular' && pb.subject.characterId === entry.characterId && pb.subject.outfitId === entry.outfitId
    : pb.subject.kind === 'studio' && Boolean(entry.character) && pb.char === entry.character
  let applied = false
  const apply = <T>(value: T | undefined, action: (value: T) => void) => {
    if (value !== undefined) { action(value); applied = true }
  }
  if (parts.style) {
    apply(entry.artistStyleIds, ids => pb.setArtistStyleIds(ids))
    apply(entry.lighting, value => pb.setLighting(value))
    apply(entry.colorMood, value => pb.setColorMood(value))
    if (entry.styleLoraId !== undefined) {
      if (engine === 'krea2' && sameEngine) {
        if (!entry.styleLoraId || animaState.value.styleLoras?.some(item => item.id === entry.styleLoraId)) apply(entry.styleLoraId, value => patchAnimaState({ styleLoraId: value ?? '' }))
        else notes.push('原风格 LoRA 不在当前已确认列表，未沿用；保留当前风格 LoRA')
      }
      else notes.push('原风格 LoRA 不适用于当前引擎，保留当前风格 LoRA')
    }
  }
  if (parts.camera) {
    apply(entry.shot, value => pb.setShot(value))
    apply(entry.composition, value => pb.setComposition(value))
  }
  if (parts.prompts) {
    if (!sameSubject || pb.outfitOverride) {
      notes.push('原角色或服装与当前条件不同，提示词未沿用；可选择完整配方后再调整')
    } else if ([entry.story, entry.visualDescription, entry.emotion, entry.manual_tags, entry.scene, entry.blueprintId].some(value => value !== undefined)) {
      if (popular && entry.blueprintId !== undefined) {
        const blueprint = entry.blueprintId ? findBlueprint(pb.sceneBlueprints, entry.blueprintId) : null
        if (!entry.blueprintId || blueprint && blueprint.characterId === entry.characterId && (!blueprint.outfitId || blueprint.outfitId === entry.outfitId)) pb.setPopularBlueprint(entry.blueprintId ?? null)
        else { pb.setPopularBlueprint(null); notes.push('原蓝图不可用或角色不匹配，已清除蓝图；请核对提示词') }
      } else if (!popular && entry.scene !== undefined) {
        const scene = pb.scenes.find(item => item.id === entry.scene)
        if (!entry.scene || scene && (!scene.char || scene.char === 'both' || scene.char === pb.char)) {
          pb.sceneId = scene?.id ?? null
          pb.sceneBaseStory = scene?.story ?? ''
        } else { pb.sceneId = null; pb.sceneBaseStory = ''; notes.push('原场景不可用或角色不匹配，已清除场景；请核对提示词') }
      }
      apply(entry.story, value => pb.setStory(value))
      apply(entry.visualDescription, value => { pb.visualDescription = value })
      apply(entry.emotion, value => { pb.selections.emotion = [...value] })
      apply(entry.manual_tags, value => { pb.manualTags = new Set(value) })
      // Incomplete records leave unrecorded layers untouched. Removing their
      // ownership alone would turn old reference tags into protected user edits.
      if (entry.manual_tags !== undefined) pb.referenceInput = null
      if (entry.manual_tags !== undefined || (popular ? entry.blueprintId !== undefined : entry.scene !== undefined)) pb.randomVariation = null
      // A stored negative is a compiled result, not a reusable custom layer.
      if (engine === 'sd') pb.sdParams.negativeCustom = ''
      notes.push('提示词按当前角色与编译规则重建；原作负向快照未写入自定义负面词')
    } else notes.push('原作未记录可重建的提示词输入，当前输入已保留')
  }
  if (parts.parameters) {
    if (!sameEngine) notes.push('原作引擎未记录或与当前引擎不同，生成参数未沿用')
    else if (engine === 'sd') {
      const savedModel = entry.model || entry.checkpoint
      if (savedModel && savedModel !== pb.sdModelName) notes.push(`原底模 ${savedModel} 与当前底模 ${pb.sdModelName || '未确认'} 不同；需先切换后端底模`)
      for (const key of ['cfg', 'steps', 'sampler', 'scheduler', 'hiresFix', 'hiresScale', 'hiresUpscaler', 'hiresSteps', 'hiresDenoise', 'faceDetailer'] as const) {
        apply(entry[key], value => { Object.assign(pb.sdParams, { [key]: value }); pb.markParamTouched(key) })
      }
      apply(entry.seed, value => { pb.sdParams.seed = value; pb.sdParams.seedLock = value >= 0; pb.markParamTouched('seed') })
      if (entry.size) {
        if (/^\d+x\d+$/.test(entry.size.replace('×', 'x'))) apply(entry.size, value => { sdSize.value = value.replace('×', 'x') })
        else notes.push('原画幅格式无效，保留当前画幅')
      }
    } else {
      const patch: Partial<typeof animaState.value> = {}
      for (const key of ['steps', 'cfg', 'sampler', 'scheduler', 'hiresFix', 'hiresScale', 'hiresDenoise'] as const) {
        apply(entry[key], value => { Object.assign(patch, { [key]: value }) })
      }
      apply(entry.seed, value => { patch.seed = value >= 0 ? value : null })
      apply(entry.model, value => { patch.modelId = value })
      if (entry.size) {
        const [width, height] = entry.size.replace('×', 'x').split('x').map(Number)
        if (Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0) { patch.width = width; patch.height = height; applied = true }
        else notes.push('原画幅格式无效，保留当前画幅')
      }
      // LoRA is owned by the current character; numeric reuse must never change it.
      if (sameSubject) apply(entry.loraStrength, value => { patch.loraStrength = value })
      patchAnimaState(patch)
    }
  }
  if (engine !== 'sd' && sameEngine && parts.parameters) {
    const before = { ...animaState.value }
    const checked = await refreshAnimaBackend()
    if (!isCurrent() || !checked) return false
    if (!animaState.value.online) notes.push('生成后端未就绪，模型与 LoRA 可用性尚未确认')
    for (const [key, label] of [['modelId', '底模'], ['styleLoraId', '风格 LoRA'], ['width', '宽度'], ['height', '高度'], ['steps', '步数'], ['cfg', 'CFG'], ['sampler', '采样器'], ['scheduler', '调度器']] as const) {
      if (before[key] !== animaState.value[key]) notes.push(`${label}：${before[key] ?? '未设置'} → ${animaState.value[key] ?? '不可用'}`)
    }
  }
  notes.push('未选部分、当前角色、服装、引擎与画册保持当前条件；未记录字段未补为原作参数')
  pb.historyRestoreReport = { title: `选择性沿用检查 · ${entry.sceneTitle || entry.id}`, notes, original: snapshotHistoricalRecipe(record) }
  pb.flash(applied ? '已沿用所选配方部分，请核对变化后生成' : '所选部分没有可沿用的已记录字段，请查看配方检查', 5000, applied ? 'info' : 'warning')
  return applied
}

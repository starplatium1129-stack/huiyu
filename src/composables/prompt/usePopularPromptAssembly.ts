import { activeRandomVariation, variedPopularScene } from '@/utils/randomVariationContext'
import { computed, type Ref } from 'vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { compilePromptRecipe } from '@/utils/promptRecipe.ts'
import {
  defaultOutfit,
  findBlueprint,
  findCharacter,
  findOutfit,
} from '@/utils/popularContent.ts'
import {
  analyzeParts,
  checkArtDirection,
  resolveModelProfile,
  tokenize,
  type PromptEngine,
} from '@/utils/promptPolicy.ts'
import { plainEnglish } from '@/utils/promptCompiler.ts'
import { COLOR_MOODS } from '@/config/promptConstants.ts'
import { artistStyleProse, artistTagsForEngine } from '@/config/artistStyles.ts'

type PromptBuilderStore = ReturnType<typeof usePromptBuilderStore>
export type PopularPromptAssemblyState = Pick<PromptBuilderStore, 'artistStyleIds' | 'colorMood' | 'directorMode' | 'emotionPrompt'
  | 'manualTags' | 'modelProfiles' | 'outfitOverride' | 'popularCharacters' | 'randomVariation' | 'sceneBlueprints' | 'selections'
  | 'directorSources' | 'subject' | 'tags' | 'visualDescription' | 'char' | 'sceneId' | 'sdParams'>

/**
 * 热门角色无 LoRA 模式的 Prompt 组装。
 *
 * 与 usePromptAssembly 完全正交：热门角色绝不流经 pb.charPrompt /
 * characterControlTokens，也就不会注入 ayachi_nene / shiki_natsume /
 * nene_* / natsume_*。渲染仍以 createPromptPlan + renderPromptPlan 为唯一
 * 模型渲染层。
 */
export function usePopularPromptAssembly(
  pb: PopularPromptAssemblyState,
  engine: Readonly<Ref<PromptEngine>>,
  modelName: Readonly<Ref<string>>,
) {
  /** 无 LoRA 模式下直接取模型 profile，不叠加任何角色 LoRA 契约。 */
  const profile = computed(() =>
    engine.value === 'anima' || engine.value === 'krea2'
      ? resolveModelProfile(pb.modelProfiles, modelName.value, engine.value)
      : null,
  )

  const character = computed(() => {
    const subject = pb.subject
    if (subject.kind !== 'popular') return null
    return findCharacter(pb.popularCharacters, subject.characterId)
  })

  const outfit = computed(() => {
    const current = character.value
    if (!current) return null
    const subject = pb.subject
    if (subject.kind !== 'popular') return null
    return findOutfit(current, subject.outfitId) ?? defaultOutfit(current)
  })

  const randomVariation = computed(() => {
    const subject = pb.subject
    const source = subject.kind === 'popular' && subject.blueprintId ? findBlueprint(pb.sceneBlueprints, subject.blueprintId) : null
    return activeRandomVariation(pb.randomVariation, pb, source)
  })

  const blueprint = computed(() => {
    const subject = pb.subject
    if (subject.kind !== 'popular' || !subject.blueprintId) return null
    const original = findBlueprint(pb.sceneBlueprints, subject.blueprintId)
    return original && randomVariation.value ? variedPopularScene(original, randomVariation.value, pb) : original
  })

  const activeArtistStyleIds = computed(() => pb.directorMode === 'pro' ? pb.artistStyleIds : [])
  const colorMoodTokens = computed(() => {
    const mood = pb.colorMood ? COLOR_MOODS.find(option => option.id === pb.colorMood) : null
    return mood ? tokenize(mood.prompt) : []
  })
  /** 词条池 Mature 分类键集（评级联动单一契约 isManualR18Tags 共用）。 */
  const matureTokenSet = computed(() =>
    new Set(pb.tags.filter(tag => tag.cat === 'Mature').map(tag => tag.en.trim().toLowerCase().replace(/\s+/g, '_'))),
  )

  const result = computed(() => {
    const subject = pb.subject
    if (subject.kind !== 'popular' || !character.value || !outfit.value) return null
    if (engine.value !== 'anima' && engine.value !== 'krea2') return null
    return compilePromptRecipe({
      kind: 'popular',
      character: character.value,
      outfit: outfit.value,
      blueprint: blueprint.value,
      engine: engine.value,
      profile: profile.value,
      manual: [...pb.manualTags],
      emotion: pb.emotionPrompt ? [pb.emotionPrompt] : [],
      shot: pb.selections.shot,
      directorSources: pb.directorSources,
      lighting: pb.selections.lighting,
      palette: colorMoodTokens.value,
      composition: pb.selections.composition,
      matureTokens: matureTokenSet.value,
      visualDescription: pb.visualDescription,
      negativeCustom: pb.sdParams.negativeCustom,
      artistTags: artistTagsForEngine(activeArtistStyleIds.value, engine.value),
      artistProse: artistStyleProse(activeArtistStyleIds.value, engine.value),
      outfitOverride: pb.outfitOverride?.tokens ?? (randomVariation.value?.outfit.length ? randomVariation.value.outfit : null),
      outfitExplicit: outfitExplicit.value,
    })
  })

  /**
   * An explicit choice includes the default outfit. Legacy drafts have no choice flag;
   * retain their nondefault selection without turning an automatic default into a choice.
   */
  const outfitExplicit = computed(() => {
    const subject = pb.subject
    if (subject.kind !== 'popular' || !subject.outfitId) return false
    if (subject.outfitExplicit !== undefined) return subject.outfitExplicit
    const current = character.value
    const fallbackId = current ? defaultOutfit(current)?.id : undefined
    return Boolean(fallbackId) && subject.outfitId !== fallbackId
  })

  const structuredPlan = computed(() => result.value?.plan ?? null)
  const positivePrompt = computed(() => result.value?.prompt ?? '')
  const negativePrompt = computed(() => result.value?.negative ?? '')
  const previewPrompt = computed(() => {
    const positive = positivePrompt.value
    if (!positive) return ''
    return negativePrompt.value ? `${positive}\n[NEG]\n${negativePrompt.value}` : positive
  })
  const promptReport = computed(() => {
    const parts: Array<{ cls: 'q' | 'n'; text: string }> = []
    if (positivePrompt.value) parts.push({ cls: 'q', text: positivePrompt.value })
    if (negativePrompt.value) parts.push({ cls: 'n', text: negativePrompt.value })
    // engine 传入后 analyzeParts 启用 Krea/Anima 契约违规检测（真实渲染文本）。
    const report = analyzeParts(parts, engine.value, profile.value)
    if (pb.visualDescription && !plainEnglish(pb.visualDescription)) {
      report.warnings.push('视觉描述含非 ASCII 字符，已按英文模型门控丢弃（请在画面描述里使用英文）')
    }
    return report
  })
  const artViolations = computed(() => checkArtDirection(positivePrompt.value, profile.value))

  return {
    profile,
    character,
    outfit,
    blueprint,
    structuredPlan,
    positivePrompt,
    negativePrompt,
    previewPrompt,
    promptReport,
    artViolations,
  }
}

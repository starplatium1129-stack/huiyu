import { computed, type Ref } from 'vue'
import { usePromptAssembly, type PromptAssemblyState } from '@/composables/prompt/usePromptAssembly'
import { usePopularPromptAssembly, type PopularPromptAssemblyState } from '@/composables/prompt/usePopularPromptAssembly'
import { useUnboundPromptAssembly } from '@/composables/prompt/useUnboundPromptAssembly'
import type { PromptEngine } from '@/utils/promptPolicy'
import { resolveDrawCapabilities } from '@/utils/drawCapabilities'
import { STUDIO_PROMPT_SUBJECTS } from '@/config/promptConstants'
import { normalizeKey, tokenize } from '@/utils/promptPrimitives'
import type { PromptPreviewContext } from '@/utils/promptPreview'
import { buildCastPlan, resolveBoundReference } from '@/utils/promptCastPlan'
import { cleanCastNegative, isCustomCastOutfit, referenceCharacterCount } from '@/utils/promptCast'
import { renderPromptPlan } from '@/utils/promptCompilerCore'
import { analyzeParts, checkArtDirection } from '@/utils/promptPolicy'
import type { CastFormation, PromptPlan } from '@/types/prompt'
export type UnifiedPromptAssemblyState = PromptAssemblyState & PopularPromptAssemblyState & {
  readonly isPopular: boolean
  readonly effectiveCastFormation: CastFormation
  readonly castInteraction: string
  readonly leadPosition: number
}

/**
 * 统一 Prompt 组装出口（P1 重构）
 * 视图层不再三元分发 `isPopular ? popular.x : studio.x`，对外只暴露一套
 * `positivePrompt/negativePrompt/previewPrompt/report`，内部按 subject 择流。
 */
export function useUnifiedPromptAssembly(
  pb: UnifiedPromptAssemblyState,
  checkpoint: Readonly<Ref<string>>,
  engine: Readonly<Ref<PromptEngine>>,
  modelName: Readonly<Ref<string>>,
  selectedLoraId: Readonly<Ref<string>>,
  kreaStyleRecipeId: Readonly<Ref<string>>,
) {
  const studio = usePromptAssembly(pb, checkpoint, engine, modelName, selectedLoraId, kreaStyleRecipeId)
  const popular = usePopularPromptAssembly(pb, engine, modelName, kreaStyleRecipeId)
  const unbound = useUnboundPromptAssembly(pb, engine, studio.modelProfile, kreaStyleRecipeId)
  const active = computed(() => pb.isPopular ? popular : pb.char === 'none' ? unbound : studio)

  const modelProfile = computed(() => pb.isPopular ? popular.profile.value : studio.modelProfile.value)
  function withCast(plan: PromptPlan | null, target: 'anima' | 'moss') {
    if (!plan || !pb.cast.length) return plan
    const onlyActor = pb.cast.length === 1 ? pb.cast[0] : null
    if (onlyActor && onlyActor.source !== 'custom' && !isCustomCastOutfit(onlyActor.outfitId)
      && (target !== 'moss' || referenceCharacterCount(pb.referenceInput?.layout) < 2)) return plan
    const resolved = resolveBoundReference(pb.referenceInput, pb.visualDescription, [...pb.manualTags], pb.popularCharacters, pb.tags)
    return buildCastPlan(plan, target, pb.cast, pb.leadPosition, pb.effectiveCastFormation, pb.popularCharacters, resolved.reference, pb.outfitOverride, resolved.description, pb.castInteraction)
  }
  const structuredPlan = computed(() => engine.value === 'anima'
    ? withCast(active.value.structuredPlan.value, 'anima') : active.value.structuredPlan.value)
  const mossPlan = computed(() => withCast(active.value.mossPlan.value, 'moss'))
  const animaCastPlan = computed(() => structuredPlan.value?.animaCast ? structuredPlan.value : null)
  const positivePrompt = computed(() => animaCastPlan.value
    ? renderPromptPlan(animaCastPlan.value, 'anima', modelProfile.value).prompt : active.value.positivePrompt.value)
  const negativePrompt = computed(() => {
    if (!animaCastPlan.value) return active.value.negativePrompt.value
    const shared = cleanCastNegative(active.value.negativePrompt.value)
    const keys = new Set(tokenize(shared).map(normalizeKey))
    return [shared, ...animaCastPlan.value.negative.filter(token => !keys.has(normalizeKey(token)))].filter(Boolean).join(', ')
  })
  const previewPrompt = computed(() => !animaCastPlan.value ? active.value.previewPrompt.value
    : [positivePrompt.value, negativePrompt.value ? `[NEG]\n${negativePrompt.value}` : ''].filter(Boolean).join('\n'))
  const promptReport = computed(() => !animaCastPlan.value ? active.value.promptReport.value
    : analyzeParts([{ cls: 'q', text: positivePrompt.value }, { cls: 'n', text: negativePrompt.value }], 'anima', modelProfile.value))
  const artViolations = computed(() => animaCastPlan.value ? checkArtDirection(positivePrompt.value, modelProfile.value) : active.value.artViolations.value)
  const previewContext = computed<PromptPreviewContext>(() => {
    const plan = structuredPlan.value
    const unbound = !pb.isPopular && pb.char === 'none' && pb.castLead?.source !== 'custom'
    const subjects = unbound ? [...Object.values(STUDIO_PROMPT_SUBJECTS), ...pb.popularCharacters] : []
    return {
      format:resolveDrawCapabilities(engine.value, modelProfile.value).promptFormat,
      qualityTokens:tokenize(modelProfile.value?.quality_prefix || ''),
      characterTokens:[...(plan?.characterTokens ?? subjects.flatMap(subject => subject.characterTokens || [])),
        ...(unbound ? pb.referenceInput?.characterTokens || [] : [])],
      copyrightTokens:[...(plan?.copyrightTokens ?? subjects.flatMap(subject => subject.copyrightTokens || [])),
        ...(unbound ? pb.referenceInput?.copyrightTokens || [] : [])],
      artists:[...(plan?.artists || [])],
    }
  })

  return {
    positivePrompt,
    negativePrompt,
    previewPrompt,
    previewContext,
    promptReport,
    artViolations,
    modelProfile,
    structuredPlan,
    mossPlan,
    // 兼容旧视图的三元分发，逐步迁移后可移除
    studio,
    popular,
  }
}

import { computed, type Ref } from 'vue'
import { usePromptAssembly, type PromptAssemblyState } from '@/composables/prompt/usePromptAssembly'
import { usePopularPromptAssembly, type PopularPromptAssemblyState } from '@/composables/prompt/usePopularPromptAssembly'
import { useUnboundPromptAssembly } from '@/composables/prompt/useUnboundPromptAssembly'
import type { PromptEngine } from '@/utils/promptPolicy'
import { resolveDrawCapabilities } from '@/utils/drawCapabilities'
import { STUDIO_PROMPT_SUBJECTS } from '@/config/promptConstants'
import { tokenize } from '@/utils/promptPrimitives'
import type { PromptPreviewContext } from '@/utils/promptPreview'
export type UnifiedPromptAssemblyState = PromptAssemblyState & PopularPromptAssemblyState & { readonly isPopular: boolean }

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
) {
  const studio = usePromptAssembly(pb, checkpoint, engine, modelName, selectedLoraId)
  const popular = usePopularPromptAssembly(pb, engine, modelName)
  const unbound = useUnboundPromptAssembly(pb, engine, studio.modelProfile)
  const active = computed(() => pb.isPopular ? popular : pb.char === 'none' ? unbound : studio)

  const positivePrompt = computed(() => active.value.positivePrompt.value)
  const negativePrompt = computed(() => active.value.negativePrompt.value)
  const previewPrompt = computed(() => active.value.previewPrompt.value)
  const promptReport = computed(() => active.value.promptReport.value)
  const artViolations = computed(() => active.value.artViolations.value)
  const modelProfile = computed(() => pb.isPopular ? popular.profile.value : studio.modelProfile.value)
  const previewContext = computed<PromptPreviewContext>(() => {
    const plan = pb.isPopular ? popular.structuredPlan.value : pb.char === 'none' ? null : studio.structuredPlan.value
    const subjects = pb.char === 'none' ? [...Object.values(STUDIO_PROMPT_SUBJECTS), ...pb.popularCharacters] : []
    return {
      format:resolveDrawCapabilities(engine.value, modelProfile.value).promptFormat,
      qualityTokens:tokenize(modelProfile.value?.quality_prefix || ''),
      characterTokens:[...(plan?.characterTokens ?? subjects.flatMap(subject => subject.characterTokens || [])),
        ...(pb.char === 'none' ? pb.referenceInput?.characterTokens || [] : [])],
      copyrightTokens:[...(plan?.copyrightTokens ?? subjects.flatMap(subject => subject.copyrightTokens || [])),
        ...(pb.char === 'none' ? pb.referenceInput?.copyrightTokens || [] : [])],
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
    // 兼容旧视图的三元分发，逐步迁移后可移除
    studio,
    popular,
  }
}

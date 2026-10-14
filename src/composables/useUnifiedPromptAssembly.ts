import { computed, type Ref } from 'vue'
import { usePromptAssembly, type PromptAssemblyState } from '@/composables/prompt/usePromptAssembly'
import { usePopularPromptAssembly, type PopularPromptAssemblyState } from '@/composables/prompt/usePopularPromptAssembly'
import type { PromptEngine } from '@/utils/promptPolicy'
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

  const positivePrompt = computed(() => pb.isPopular ? popular.positivePrompt.value : studio.positivePrompt.value)
  const negativePrompt = computed(() => pb.isPopular ? popular.negativePrompt.value : studio.negativePrompt.value)
  const previewPrompt = computed(() => pb.isPopular ? popular.previewPrompt.value : studio.previewPrompt.value)
  const promptReport = computed(() => pb.isPopular ? popular.promptReport.value : studio.promptReport.value)
  const artViolations = computed(() => pb.isPopular ? popular.artViolations.value : studio.artViolations.value)
  const modelProfile = computed(() => pb.isPopular ? popular.profile.value : studio.modelProfile.value)

  return {
    positivePrompt,
    negativePrompt,
    previewPrompt,
    promptReport,
    artViolations,
    modelProfile,
    loraSpecs: studio.loraSpecs,
    // 兼容旧视图的三元分发，逐步迁移后可移除
    studio,
    popular,
  }
}

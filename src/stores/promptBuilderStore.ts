import { usePromptCatalogData } from './usePromptCatalogData'
import type { StoryOrigin } from '@/types/storyOrigin'
import { usePromptDraft } from '@/composables/prompt/usePromptDraft'
import { usePromptSceneFilters } from '@/composables/prompt/usePromptSceneFilters'
import { usePromptArtworkHistory } from '@/composables/prompt/usePromptArtworkHistory'
import { activeRandomVariation, randomVariationContext, sceneStyleBaseline, withoutRandomOutfit } from '@/utils/randomVariationContext'
import { inferBlueprintDecisions } from '@/utils/popularBlueprintDecisions'
import { DIRECTOR_CONTROL_KEYS, restoreDirectorSources, sceneDirectorSources } from '@/utils/promptDirector'
import type { DirectorControlSource, DirectorControlSources, DirectorControlValues } from '@/types/promptDirector'
export type { Scene } from '../types/scene'

import { defineStore } from 'pinia'
import { ref, reactive, computed, watch } from 'vue'
import { normalizeKey, type ModelProfile } from '@/utils/promptPolicy'
import { useSceneStore } from '@/stores/sceneStore'
import { applyModelProfileToParams } from '@/utils/promptModelProfile'
import { usePromptTags } from '@/composables/prompt/usePromptTags'
import { parsePromptScenes, parsePromptCharacters, parsePromptLoras, parsePromptTags } from '@/utils/promptCatalog'
import { useToast } from '@/composables/useToast'
import { usePromptCastAndSubject } from '@/composables/prompt/usePromptCastAndSubject'
import { usePromptSceneOperations } from '@/composables/prompt/usePromptSceneOperations'

const toast = useToast()

import {
  cloneReferenceInput,
  isSDParamKey,
  type DraftOutfitOverride,
  type DraftReferenceInput,
  type DraftRandomVariation,
  type SDParams,
} from '@/utils/promptBuilderPersistence'
import type { DrawSubject } from '@/utils/popularContent'
import type { CastFormation, CastMember } from '@/types/prompt'
import type { RecipeRestoreReport } from '@/utils/recipeComparison'
import { normalizeArtistStyleIds } from '@/config/artistStyles'
import { CHAR_PROMPT, EMOTION } from '@/config/promptConstants'
import { sanitizeOutfitOverride, wardrobeTokens } from '@/utils/wardrobeContent'
export { CHAR_PROMPT } from '@/config/promptConstants'

import type { CharKey, Selections } from '@/types/promptHistory'
export type { CharKey, HistoryEntry } from '@/types/promptHistory'

const PROMPT_MAP_EMOTION: Record<string, string> = Object.fromEntries(EMOTION.map(item => [item.id, item.prompt || '']))

export const usePromptBuilderStore = defineStore('promptBuilder', () => {
  // ── Core director state ─────────────────────────────────────────────────
  const storyOrigin = ref<StoryOrigin>()
  const story = ref('')
  const visualDescription = ref('')
  const char = ref<CharKey>('nene')
  /** 热门角色无 LoRA 创作模式与工作室角色互斥；studio 路径继续用 char。 */
  const subject = ref<DrawSubject>({ kind: 'studio' })
  const isPopular = computed(() => subject.value.kind === 'popular')
  const colorMood = ref<string | null>(null)
  const concise = ref(false)
  const sceneId = ref<string | null>(null)
  const sceneBaseStory = ref('')
  const selections = reactive<Selections>({ emotion: [], shot: null, lighting: null, composition: null })
  const directorSources = ref<DirectorControlSources>(sceneDirectorSources())
  /** 参考图或衣橱选择的服装；清空后恢复场景原有衣装。 */
  const outfitOverride = ref<DraftOutfitOverride | null>(null)
  const referenceInput = ref<DraftReferenceInput | null>(null)
  const coStars = ref<CastMember[]>([])
  const castFormation = ref<CastFormation>()
  const castInteraction = ref('')
  const effectiveCastFormation = computed(() => castFormation.value ?? (castInteraction.value.trim() ? 'close' : 'row'))
  const leadCast = ref<CastMember | null>(null)
  const leadPosition = ref(0)
  const isUnbound = computed(() => !isPopular.value && char.value === 'none' && leadCast.value?.source !== 'custom')
  const randomVariation = ref<DraftRandomVariation | null>(null)
  watch([char, sceneId, subject, outfitOverride], ([nextChar, nextScene, next, override], [oldChar, oldScene, old, oldOverride]) => {
    if (!randomVariation.value) return
    if (nextChar !== oldChar || nextScene !== oldScene || next.kind !== old.kind
      || (next.kind === 'popular' && old.kind === 'popular' && (next.characterId !== old.characterId || next.blueprintId !== old.blueprintId))) {
      clearRandomVariation()
      return
    }
    const outfitChanged = next.kind === 'popular' && old.kind === 'popular'
      && (next.outfitId !== old.outfitId || next.outfitExplicit !== old.outfitExplicit)
    if (outfitChanged || JSON.stringify(override?.tokens) !== JSON.stringify(oldOverride?.tokens)) {
      const source = next.kind === 'popular' ? sceneBlueprints.value.find(item => item.id === next.blueprintId) ?? null : activeScene.value
      const variation = activeRandomVariation(randomVariation.value, { char: oldChar, sceneId: oldScene, subject: old }, source)
      if (!variation) { clearRandomVariation(); return }
      removeRandomOutfitTags()
      const adjusted = withoutRandomOutfit(variation, source, tags.value)
      randomVariation.value = { ...adjusted, context: randomVariationContext({ char: nextChar, sceneId: nextScene, subject: next }) }
    }
  }, { flush: 'sync' })
  const artistStyleIds = ref<string[]>([])
  const projectId = ref('')

  // ── Loaded data (proxy to sceneStore, single source, no drift) ───────
  const sceneStore = useSceneStore()
  const { history, historyLoading, historyError, readHistoryEntry, commitHistoryEntry, removeHistoryEntry, restoreHistoryEntry, loadHistory } = usePromptArtworkHistory(entry => resolveLegacyArtworkDefaults(entry))
  const scenes = computed(() => parsePromptScenes(sceneStore.scenes))
  const curation = computed(() => sceneStore.curation)
  const loraMeta = computed(() => parsePromptLoras(sceneStore.loras))
  const tags = computed(() => parsePromptTags(sceneStore.tags))
  const { manualTags, tagDictionary, addManualTag: addTag, toggleManualTag: toggleTag } = usePromptTags(() => tags.value, flash)

  // Explicit user edits take ownership; later reference replacement must not erase them.
  function releaseReferenceTag(input: string) {
    if (!referenceInput.value) return
    const key = normalizeKey(tagDictionary.value.canonicalize(input))
    const nextTags = referenceInput.value.tags.filter(tag => normalizeKey(tagDictionary.value.canonicalize(tag)) !== key)
    referenceInput.value = cloneReferenceInput(referenceInput.value, nextTags)
  }
  function addManualTag(input: string) {
    releaseSuppressedTag(input)
    const outcome = addTag(input)
    if (outcome !== 'duplicate') releaseReferenceTag(input)
    return outcome
  }
  function releaseSuppressedTag(input: string) {
    if (!outfitOverride.value?.suppressedTags?.length) return
    const key = normalizeKey(tagDictionary.value.canonicalize(input))
    if (!outfitOverride.value.suppressedTags.some(tag => normalizeKey(tag) === key)) return
    outfitOverride.value = { ...outfitOverride.value, suppressedTags: outfitOverride.value.suppressedTags.filter(tag => normalizeKey(tag) !== key) }
  }
  function toggleManualTag(input: string) { releaseSuppressedTag(input); releaseReferenceTag(input); toggleTag(input) }
  watch([manualTags, tagDictionary], () => {
    if (!referenceInput.value) return
    const canonicalize = tagDictionary.value.canonicalize
    const current = new Set([...manualTags.value].map(normalizeKey))
    referenceInput.value = cloneReferenceInput({
      ...referenceInput.value,
      tags: referenceInput.value.tags.map(canonicalize).filter(tag => current.has(normalizeKey(tag))),
      characterTokens: referenceInput.value.characterTokens?.map(canonicalize),
      copyrightTokens: referenceInput.value.copyrightTokens?.map(canonicalize),
    })
  }, { deep: true, flush: 'sync' })

  const characters = computed(() => parsePromptCharacters(sceneStore.drawingProfiles))
  const popularCharacters = computed(() => sceneStore.popularCharacters)
  const loadPopularCatalog = sceneStore.loadPopularCharacters
  /** 当前主体对应的画师专属推荐（2026-09-05 从 PromptBuilderView 迁入：纯 store 派生）。 */
  const currentCuratedArtistStyles = computed<string[]>(() => {
    if (isUnbound.value) return []
    if (isPopular.value) {
      const charId = subject.value.kind === 'popular' ? subject.value.characterId : ''
      const current = popularCharacters.value.find(c => c.id === charId)
      return current?.curatedArtistStyles || []
    }
    // 工作室角色（宁宁 / 夏目 -> 柚子社画风 Kobuichi / Muririn / Kantoku）
    return ['kobuichi', 'muririn', 'kantoku']
  })
  const sceneBlueprints = computed(() => sceneStore.sceneBlueprints)
  const { modelProfiles, dataReady, dataLoading, dataError, loadData } = usePromptCatalogData(sceneStore, applyModelProfile)
  const historyRestoreReport = ref<RecipeRestoreReport | null>(null)

  // ── SD state ────────────────────────────────────────────────────────────
  // 生成生命周期状态（online/generating/progress/result/error）由 useLegacySdTasks
  // 与 Anima 会话组合函数拥有，store 只保留跨引擎的底模选择与种子记忆。
  const sdModelName = ref('')
  const lastSeed = ref<number | null>(null)

  // ── SD params (synced from UI) ──────────────────────────────────────────
  // 默认值对齐 data/presets.json 的 WAI Illustrious v17（本站 LoRA 的训练底模）
  // 实际值在 loadData 后由 applyModelProfile() 按当前 checkpoint 覆盖
  const sdParams = reactive<SDParams>({
    cfg: 6, steps: 30, sampler: 'Euler a', scheduler: '',
    size: '2:3', hiresFix: false, hiresScale: 1.5,
    hiresUpscaler: 'Auto', hiresSteps: 20, hiresDenoise: 0.4,
    faceDetailer: true,
    seedLock: false, seed: -1, quality: true, tail: true, negative: true,
    negativeCustom: '',
  })

  /** 用户是否手动改过某个参数（改过就不再被 profile 覆盖） */
  const sdParamsTouched = ref<Set<keyof SDParams>>(new Set())
  function markParamTouched(key: string) {
    if (isSDParamKey(key)) sdParamsTouched.value.add(key)
  }

  // ── Voice state ─────────────────────────────────────────────────────────
  // 配音状态（online/mode/caption/custom）由 VoiceStudio.vue 与 useVoice 拥有，
  // 这里不再重复存放，避免两份状态漂移。

  const { focusMode, directorMode, sceneSearch, sceneTheme, filteredScenes } = usePromptSceneFilters(scenes, char)
  const lastRecommendedSize = ref('832x1216')

  // ── Derived ─────────────────────────────────────────────────────────────
  const activeScene = computed(() =>
    sceneId.value ? scenes.value.find(s => s.id === sceneId.value) ?? null : null
  )
  const inheritedDirectorValues = computed<DirectorControlValues>(() => {
    const current = subject.value
    if (current.kind === 'popular') {
      const blueprint = sceneBlueprints.value.find(item => item.id === current.blueprintId)
      return blueprint ? inferBlueprintDecisions(blueprint) : {}
    }
    return activeScene.value ? sceneStyleBaseline(activeScene.value) : {}
  })

  const charPrompt = computed(() => CHAR_PROMPT[char.value] ?? '')

  let warnedFreeReference: DraftReferenceInput | null = null
  watch(isUnbound, (unbound, wasUnbound) => {
    if (wasUnbound && !unbound && referenceInput.value?.subjectMode === 'free' && warnedFreeReference !== referenceInput.value) {
      warnedFreeReference = referenceInput.value
      flash('参考图含原人物外观。可重新反推，仅提取动作、服装和环境。', 4400)
    }
  })

  const loraLine = computed(() => {
    if (isUnbound.value || !characters.value.length) return ''
    const match = characters.value.find(c =>
      char.value === 'triad'
        ? c.lora?.name?.includes('ayachi') || c.lora?.name?.includes('shiki')
        : c.id.includes(char.value) || c.lora?.name?.toLowerCase().includes(char.value)
    )
    if (!match?.lora) return ''
    if (char.value === 'triad') {
      const both = characters.value.filter(c =>
        c.lora && (c.lora.name.includes('ayachi') || c.lora.name.includes('shiki'))
      )
      return both.map(c => `<${c.lora!.name}:${c.lora!.weight}>`).join(', ')
    }
    return `<${match.lora.name}:${match.lora.weight}>`
  })

  const emotionPrompt = computed(() =>
    selections.emotion.map(e => PROMPT_MAP_EMOTION[e] || e).filter(Boolean).join(', ')
  )

  // ── Mutations ───────────────────────────────────────────────────────────
  function removeRandomOutfitTags() {
    const outfit = new Set(randomVariation.value?.outfit.map(normalizeKey) ?? [])
    if (outfit.size) manualTags.value = new Set([...manualTags.value].filter(token => !outfit.has(normalizeKey(token))))
  }
  function clearRandomVariation() {
    removeRandomOutfitTags()
    randomVariation.value = null
  }
  function setStory(t: string) { story.value = t }
  function setShot(id: string | null, source: DirectorControlSource = 'manual') { selections.shot = id; directorSources.value.shot = source }
  function setLighting(id: string | null, source: DirectorControlSource = 'manual') { selections.lighting = id; directorSources.value.lighting = source }
  function setComposition(id: string | null, source: DirectorControlSource = 'manual') { selections.composition = id; directorSources.value.composition = source }
  function setColorMood(id: string | null, source: DirectorControlSource = 'manual') { colorMood.value = id; directorSources.value.colorMood = source }
  function restoreDirectorState(values: DirectorControlValues, sources: unknown, inherited = inheritedDirectorValues.value) {
    selections.shot = values.shot ?? null; selections.lighting = values.lighting ?? null
    selections.composition = values.composition ?? null; colorMood.value = values.colorMood ?? null
    directorSources.value = restoreDirectorSources(sources, values, inherited)
  }
  function clearInheritedDirectorValues() {
    for (const key of DIRECTOR_CONTROL_KEYS) {
      if (directorSources.value[key] !== 'scene') continue
      if (key === 'colorMood') colorMood.value = null
      else selections[key] = null
    }
  }
  function setArtistStyleIds(ids: string[]) { artistStyleIds.value = normalizeArtistStyleIds(ids) }

  /** 反推出跨族服装：顶替角色默认服装（replaced 为被顶替的服装族名，用于提示）。 */
  function setOutfitOverride(tokens: string[], replaced: string | null, preset?: Pick<DraftOutfitOverride, 'presetId' | 'label' | 'prose' | 'suppressedTags'>) {
    const normalized = [...new Set(wardrobeTokens(tokens.map(tagDictionary.value.canonicalize)))]
    if (tokens.length && !normalized.length) return
    outfitOverride.value = sanitizeOutfitOverride({
      tokens: normalized, replaced,
      ...(preset?.presetId ? { presetId: preset.presetId } : {}), ...(preset?.label ? { label: preset.label } : {}),
      ...(preset?.prose ? { prose: preset.prose } : {}), ...(preset?.suppressedTags?.length ? { suppressedTags: [...preset.suppressedTags] } : {}),
    })
  }
  /** 一键恢复角色默认服装。 */
  function clearOutfitOverride() { outfitOverride.value = null }

  /** A new scene owns its environment; retain tags explicitly adopted or entered by the user. */
  function clearReferenceInput() {
    if (!referenceInput.value) return
    if (referenceInput.value.captionInEditor && referenceInput.value.caption === visualDescription.value) visualDescription.value = ''
    const owned = new Set(referenceInput.value.tags.map(tagDictionary.value.canonicalize).map(normalizeKey))
    referenceInput.value = null
    manualTags.value = new Set([...manualTags.value].filter(tag => !owned.has(normalizeKey(tag))))
  }

  const {
    popularBlueprintReady, popularBlueprintLoading, popularBlueprintError, loadPopularCharacter,
    castLead, cast, castRequiresNoLora,
    setChar, setStudioSubject, setUnboundSubject, setPopularSubject, setPopularBlueprint,
    addCoStar, updateCastMember, moveCastMember, selectCastLead, removeCastMember,
  } = usePromptCastAndSubject({
    char, subject, isPopular, isUnbound, storyOrigin, story, sceneId, sceneBaseStory,
    selections, colorMood, directorSources, outfitOverride, referenceInput,
    coStars, castFormation, castInteraction, leadCast, leadPosition, artistStyleIds, manualTags,
    popularCharacters, sceneBlueprints, activeScene, sceneStore, loadPopularCatalog,
    clearRandomVariation, clearReferenceInput, clearInheritedDirectorValues,
  })

  const { loadScene, clearScene, snapshotStyleLayers, restoreStyleLayers, resolveLegacyArtworkDefaults } = usePromptSceneOperations({
    storyOrigin, story, visualDescription, char, subject, sceneId, sceneBaseStory,
    selections, colorMood, directorSources, manualTags, referenceInput, outfitOverride,
    randomVariation, artistStyleIds, sdParams, sdParamsTouched, sdModelName, lastSeed,
    lastRecommendedSize, projectId, directorMode, activeScene, loraLine,
    popularCharacters, sceneBlueprints, restoreDirectorState,
  })

  // 2026-08-29 UX 收编：原生自绘 pb-toast 退役，统一走全局 useToast。
  function flash(msg: string, duration = 2500, type: 'info' | 'success' | 'warning' | 'error' = 'info') {
    toast.show(msg, type, duration)
  }

  function applyModelProfile(modelName?: string, options: { applySize?: boolean } = {}): ModelProfile | null {
    return applyModelProfileToParams(modelProfiles.value, modelName || sdModelName.value, sdParams, sdParamsTouched.value, lastRecommendedSize, options)
  }

  /**
   * 把出图参数恢复为当前底模的推荐值（2026-08-30 UX 审计 P1）。
   *
   * 关键是先清 touched：applyModelProfileToParams 会跳过用户碰过的字段，
   * 不清的话「恢复默认」点下去界面纹丝不动，用户只会判定按钮坏了。
   * 返回是否真的套上了 profile（false 表示没有匹配档位，调用方据此提示）。
   */
  function resetParamsToProfile(): boolean {
    sdParamsTouched.value = new Set<keyof SDParams>()
    return Boolean(applyModelProfile(sdModelName.value, { applySize: true }))
  }

  const { snapshotDraft, saveDraft, persistDraft, restoreDraft, draftSaveState, draftSaveError, retryDraftSave } = usePromptDraft({ subject, storyOrigin, story, visualDescription, char, sceneId, activeScene, selections, colorMood, directorSources, inheritedDirectorValues, sceneBlueprints, loadPopularCharacter, loadPopularCatalog, manualTags, outfitOverride, referenceInput, coStars, castFormation, castInteraction, leadCast, leadPosition, randomVariation, artistStyleIds, sceneBaseStory, directorMode, sdParams, sdParamsTouched, projectId, scenes, lastRecommendedSize, dataReady, flash })

  return {
    storyOrigin, story, visualDescription, char, colorMood, concise, sceneId, sceneBaseStory,
    selections, directorSources, inheritedDirectorValues, manualTags, tagDictionary, artistStyleIds, projectId, historyRestoreReport,
    subject, isPopular, isUnbound, outfitOverride, referenceInput, randomVariation,
    cast, castLead, castRequiresNoLora, coStars, castFormation, castInteraction, effectiveCastFormation, leadCast, leadPosition, addCoStar, updateCastMember, moveCastMember, selectCastLead, removeCastMember,
    scenes, curation, loraMeta, modelProfiles, tags, characters,
    popularCharacters, sceneBlueprints, dataReady, dataLoading, dataError, loadPopularCharacter,
    loadPopularCatalog,
    popularBlueprintReady, popularBlueprintLoading, popularBlueprintError,
    history, historyLoading, historyError, readHistoryEntry,
    sdModelName, lastSeed, sdParams,
    focusMode, directorMode, sceneSearch, sceneTheme, lastRecommendedSize,
    activeScene, charPrompt, loraLine, emotionPrompt, filteredScenes, currentCuratedArtistStyles,
    setChar, setStory, setShot, setLighting, setComposition,
    setColorMood, toggleManualTag, addManualTag, setArtistStyleIds, loadScene, clearScene, flash,
    setOutfitOverride, clearOutfitOverride, clearReferenceInput, clearRandomVariation,
    snapshotStyleLayers, restoreStyleLayers,
    restoreDirectorState, clearInheritedDirectorValues,
    setStudioSubject, setUnboundSubject, setPopularSubject, setPopularBlueprint,
    loadData, loadHistory,
    saveDraft, persistDraft, restoreDraft, snapshotDraft, draftSaveState, draftSaveError, retryDraftSave,
    commitHistoryEntry, removeHistoryEntry, restoreHistoryEntry,
    sdParamsTouched, markParamTouched, applyModelProfile, resetParamsToProfile,
  }
})

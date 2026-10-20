import type { StoryOrigin } from '@/types/storyOrigin'
import { usePromptDraft } from '@/composables/prompt/usePromptDraft'
import { usePromptSceneFilters } from '@/composables/prompt/usePromptSceneFilters'
import { usePromptArtworkHistory } from '@/composables/prompt/usePromptArtworkHistory'
import { sceneStyleBaseline } from '@/utils/randomVariationContext'
import { inferBlueprintDecisions } from '@/utils/popularBlueprintDecisions'
import { DIRECTOR_CONTROL_KEYS, normalizeDirectorSources, restoreDirectorSources, sceneDirectorSources } from '@/utils/promptDirector'
import type { DirectorControlSource, DirectorControlSources, DirectorControlValues } from '@/types/promptDirector'
import type { Scene } from '../types/scene'
export type { Scene } from '../types/scene'

import { defineStore } from 'pinia'
import type { GeneratedArtworkInput, LegacyArtworkDefaults } from '@/application/artwork/artworkSaveInput'
import { ref, reactive, computed, watch, onScopeDispose } from 'vue'
import { sceneLighting, sceneShot, sceneColorMood, sceneComposition, sceneRecommendedSize } from '@/utils/sceneInference'
import { normalizeKey, sceneSupportsCharacter, type ModelProfile } from '@/utils/promptPolicy'
import { useSceneStore } from '@/stores/sceneStore'
import { applyModelProfileToParams } from '@/utils/promptModelProfile'
import { usePromptTags } from '@/composables/prompt/usePromptTags'
import { parsePromptScenes, parsePromptCharacters, parsePromptLoras, parsePromptTags } from '@/utils/promptCatalog'
import { useToast } from '@/composables/useToast'

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
import type { RecipeRestoreReport } from '@/utils/recipeComparison'
import { normalizeArtistStyleIds } from '@/config/artistStyles'
import { CHAR_PROMPT, EMOTION } from '@/config/promptConstants'
export { CHAR_PROMPT } from '@/config/promptConstants'

import type { CharKey, Selections } from '@/types/promptHistory'
export type { CharKey, HistoryEntry } from '@/types/promptHistory';

const PROMPT_MAP_EMOTION: Record<string, string> = Object.fromEntries(EMOTION.map(item => [item.id, item.prompt || '']))

export const NEGATIVE_DEFAULT = 'worst quality, low quality, normal quality, lowres, blurry, jpeg artifacts, text, watermark, logo, signature, bad anatomy, bad hands, extra fingers, missing fingers, extra arms, extra legs, deformed, cropped, duplicate'

export const usePromptBuilderStore = defineStore('promptBuilder', () => {
  // ── Core director state ─────────────────────────────────────────────────
  const storyOrigin = ref<StoryOrigin>()
  const story     = ref('')
  const visualDescription = ref('')
  const char      = ref<CharKey>('nene')
  /** 热门角色无 LoRA 创作模式与工作室角色互斥；studio 路径继续用 char。 */
  const subject   = ref<DrawSubject>({ kind: 'studio' })
  const isPopular = computed(() => subject.value.kind === 'popular')
  const isUnbound = computed(() => !isPopular.value && char.value === 'none')
  const colorMood = ref<string | null>(null)
  const concise   = ref(false)
  const sceneId   = ref<string | null>(null)
  const sceneBaseStory = ref('')
  const selections = reactive<Selections>({ emotion: [], shot: null, lighting: null, composition: null })
  const directorSources = ref<DirectorControlSources>(sceneDirectorSources())
  /**
   * 反推顶替的服装（2026-08-29）。非空时，热门角色用参考图服装**整体替换**
   * 角色默认服装（outfit.tokens + outfit.prose 一起换；只换 tag 不换散文无效）。
   * 清空即恢复角色默认服装。studio 路径（宁宁/夏目）不使用——它们无默认服装注入。
   */
  const outfitOverride = ref<DraftOutfitOverride | null>(null)
  const referenceInput = ref<DraftReferenceInput | null>(null)
  const randomVariation = ref<DraftRandomVariation | null>(null)
  watch(() => JSON.stringify([char.value, sceneId.value, subject.value, outfitOverride.value]), clearRandomVariation, { flush: 'sync' })
  const artistStyleIds = ref<string[]>([])
  const projectId  = ref('')

  // ── Loaded data (proxy to sceneStore, single source, no drift) ───────
  const sceneStore = useSceneStore()
  const { history, commitHistoryEntry, removeHistoryEntry, restoreHistoryEntry, loadHistory } = usePromptArtworkHistory(resolveLegacyArtworkDefaults)
  const scenes = computed(() => parsePromptScenes(sceneStore.scenes))
  const curation = computed(() => sceneStore.curation)
  const loraMeta = computed(() => parsePromptLoras(sceneStore.loras))
  const tags = computed(() => parsePromptTags(sceneStore.tags))
  const { manualTags, tagDictionary, addManualTag: addTag, toggleManualTag: toggleTag } = usePromptTags(() => tags.value, flash)
  // Explicit user edits take ownership; later reference replacement must not erase them.
  function releaseReferenceTag(input: string) {
    if (!referenceInput.value) return
    const key = normalizeKey(tagDictionary.value.canonicalize(input))
    const tags = referenceInput.value.tags.filter(tag => normalizeKey(tagDictionary.value.canonicalize(tag)) !== key)
    referenceInput.value = cloneReferenceInput(referenceInput.value, tags)
  }
  function addManualTag(input: string) {
    const outcome = addTag(input)
    if (outcome !== 'duplicate') releaseReferenceTag(input)
    return outcome
  }
  function toggleManualTag(input: string) { releaseReferenceTag(input); toggleTag(input) }
  watch([manualTags, tagDictionary], () => {
    if (!referenceInput.value) return
    const canonicalize = tagDictionary.value.canonicalize
    const current = new Set([...manualTags.value].map(normalizeKey))
    referenceInput.value = cloneReferenceInput({
      tags: referenceInput.value.tags.map(canonicalize).filter(tag => current.has(normalizeKey(tag))),
      characterTokens: referenceInput.value.characterTokens?.map(canonicalize),
      copyrightTokens: referenceInput.value.copyrightTokens?.map(canonicalize),
    })
  }, { deep: true, flush: 'sync' })
  const characters = computed(() => parsePromptCharacters(sceneStore.characters))
  const popularCharacters = computed(() => sceneStore.popularCharacters)
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
  const modelProfiles = ref<ModelProfile[]>([])
  const dataReady = ref(false)
  const dataLoading = ref(false), dataError = ref('')
  let dataRequest: Promise<void> | null = null
  const historyRestoreReport = ref<RecipeRestoreReport | null>(null)
  const popularBlueprintCharacter = computed(() => subject.value.kind === 'popular' ? subject.value.characterId : '')
  const popularBlueprintReady = computed(() => !popularBlueprintCharacter.value || sceneStore.hasBlueprintCharacter(popularBlueprintCharacter.value))
  const popularBlueprintLoading = ref(false), popularBlueprintError = ref('')
  let popularBlueprintRequest = 0
  async function loadPopularCharacter(id: string) {
    if (!id) return
    const request = id === popularBlueprintCharacter.value ? ++popularBlueprintRequest : -1
    const current = () => request === popularBlueprintRequest && id === popularBlueprintCharacter.value
    if (current()) {
      popularBlueprintLoading.value = !sceneStore.hasBlueprintCharacter(id)
      popularBlueprintError.value = ''
    }
    try {
      // SceneStore deduplicates reads and owns the catalog epoch/cache; other
      // consumers may still need a character after this workspace switches away.
      await sceneStore.loadBlueprintCharacter(id)
    } catch (error) {
      if (current()) popularBlueprintError.value = error instanceof Error ? error.message : '当前角色场景建议读取失败，请重新读取。'
      throw error
    } finally { if (current()) popularBlueprintLoading.value = false }
  }
  watch([popularBlueprintCharacter, popularBlueprintReady, () => sceneStore.version], ([id, ready]) => {
    popularBlueprintRequest++
    popularBlueprintLoading.value = false; popularBlueprintError.value = ''
    if (id && !ready) void loadPopularCharacter(id).catch(() => {})
    // The default pre-flush waits for invalidate() to clear its old request map.
  }, { immediate: true })
  onScopeDispose(() => { popularBlueprintRequest++ })

  // ── SD state ────────────────────────────────────────────────────────────
  // 生成生命周期状态（online/generating/progress/result/error）由 useLegacySdTasks
  // 与 Anima 会话组合函数拥有，store 只保留跨引擎的底模选择与种子记忆。
  const sdModelName   = ref('')
  const lastSeed      = ref<number | null>(null)

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
  function clearRandomVariation() {
    const outfit = new Set(randomVariation.value?.outfit.map(normalizeKey) ?? [])
    if (outfit.size) manualTags.value = new Set([...manualTags.value].filter(token => !outfit.has(normalizeKey(token))))
    randomVariation.value = null
  }
  function clearInheritedStory(nextBlueprintId: string | null = null) {
    const current = subject.value
    if (current.kind === 'popular' && current.blueprintId === nextBlueprintId) return
    const inherited = current.kind === 'popular'
      ? sceneBlueprints.value.find(scene => scene.id === current.blueprintId)?.description
      : sceneBaseStory.value
    if (story.value === inherited) story.value = ''
  }
  function setChar(c: CharKey) {
    if (storyOrigin.value && !isPopular.value) storyOrigin.value = ['nene','natsume'].includes(c) ? { ...storyOrigin.value, characterId: c, outfitId: undefined } : undefined
    const scene = activeScene.value
    if (!isPopular.value && scene && !sceneSupportsCharacter(scene, c)) {
      clearInheritedStory()
      sceneId.value = null; sceneBaseStory.value = ''
      clearInheritedDirectorValues()
    }
    char.value = c
  }
  function setStudioSubject() {
    if (subject.value.kind === 'studio') return
    storyOrigin.value = undefined
    clearInheritedStory()
    subject.value = { kind: 'studio' }
    clearReferenceInput()
    outfitOverride.value = null
  }
  function setUnboundSubject() {
    storyOrigin.value = undefined
    clearInheritedStory()
    clearRandomVariation()
    for (const token of outfitOverride.value?.tokens ?? []) manualTags.value.add(token)
    subject.value = { kind: 'studio' }
    char.value = 'none'
    sceneId.value = null; sceneBaseStory.value = ''
    outfitOverride.value = null
    selections.emotion = []; selections.shot = null; selections.lighting = null; selections.composition = null
    colorMood.value = null; artistStyleIds.value = []
    directorSources.value = sceneDirectorSources()
  }
  function setPopularSubject(characterId: string, outfitId: string, blueprintId: string | null = null,
    options: { preserveReference?: boolean; preserveOutfitOverride?: boolean; outfitExplicit?: boolean } = {}) {
    clearInheritedStory(blueprintId)
    if (storyOrigin.value) storyOrigin.value = blueprintId ? undefined : { ...storyOrigin.value, characterId, outfitId, outfitProse: undefined }
    clearRandomVariation()
    subject.value = { kind: 'popular', characterId, outfitId, blueprintId, outfitExplicit: options.outfitExplicit }
    if (!options.preserveReference) clearReferenceInput()
    if (!options.preserveOutfitOverride) outfitOverride.value = null
  }
  function setPopularBlueprint(blueprintId: string | null) {
    if (blueprintId) storyOrigin.value = undefined
    clearRandomVariation()
    if (subject.value.kind !== 'popular') return
    clearInheritedStory(blueprintId)
    subject.value = { ...subject.value, blueprintId }
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
  function setOutfitOverride(tokens: string[], replaced: string | null) {
    outfitOverride.value = tokens.length ? { tokens: [...new Set(tokens.map(tagDictionary.value.canonicalize))], replaced } : null
  }
  /** 一键恢复角色默认服装。 */
  function clearOutfitOverride() { outfitOverride.value = null }

  /** A new scene owns its environment; retain tags explicitly adopted or entered by the user. */
  function clearReferenceInput() {
    if (!referenceInput.value) return
    const owned = new Set(referenceInput.value.tags.map(tagDictionary.value.canonicalize).map(normalizeKey))
    referenceInput.value = null
    manualTags.value = new Set([...manualTags.value].filter(tag => !owned.has(normalizeKey(tag))))
  }

  function loadScene(scene: Scene) {
    storyOrigin.value = undefined
    randomVariation.value = null
    // 工作室场景天然属于 studio 组装分支：热门角色(popular)模式下用 ?scene= 深链
    // （灵感场景/全景搜索/历史恢复）切回宁宁或夏目场景时，若不把 subject 兜底回
    // studio，isPopular 仍为 true，livePrompt 会继续走 usePopularPromptAssembly，
    // 提示词仍是上一个热门角色的、不会跟随本场景（2026 真机复现）。
    subject.value = { kind: 'studio' }
    sceneId.value       = scene.id
    sceneBaseStory.value = scene.story ?? ''
    story.value         = scene.story ?? story.value
    // Search metadata is not prompt input. Visual prose must be explicit.
    visualDescription.value = ''
    if (scene.char && scene.char !== 'both' && scene.char !== 'triad') {
      char.value = scene.char as CharKey
    }
    // 选场景是一次完整的导演决策复位：旧镜头/光照/构图/情调/情绪/手动词条/
    // 自定义负面/被触摸参数全部清空，再写入本场景的智能推断（含 null）。
    selections.emotion = []
    selections.shot = sceneShot(scene)
    selections.lighting = sceneLighting(scene)
    selections.composition = sceneComposition(scene)
    colorMood.value = sceneColorMood(scene)
    directorSources.value = sceneDirectorSources()
    manualTags.value = new Set()
    referenceInput.value = null
    outfitOverride.value = null
    sdParams.negativeCustom = ''
    sdParamsTouched.value = new Set()
    // 推荐尺寸（优先场景显式字段，供视图书写）
    lastRecommendedSize.value = sceneRecommendedSize(scene)
  }

  function clearScene(opts: { keepStory?: boolean } = {}) {
    storyOrigin.value = undefined
    randomVariation.value = null
    sceneId.value = null; sceneBaseStory.value = ''; visualDescription.value = ''; manualTags.value = new Set()
    outfitOverride.value = null
    referenceInput.value = null
    selections.emotion = []; selections.shot = null; selections.lighting = null
    selections.composition = null; colorMood.value = null
    directorSources.value = sceneDirectorSources()
    if (!opts.keepStory) story.value = ''
  }

  /** 风格层快照（随机灵感撤销用）：情绪/镜头/光照/构图/色彩/手动词条/画师。 */
  function snapshotStyleLayers() {
    return {
      emotions: [...selections.emotion],
      shot: selections.shot,
      lighting: selections.lighting,
      composition: selections.composition,
      colorMood: colorMood.value,
      directorSources: normalizeDirectorSources(directorSources.value),
      manualTags: [...manualTags.value],
      randomVariation: randomVariation.value ? JSON.parse(JSON.stringify(randomVariation.value)) as DraftRandomVariation : null,
      referenceInput: cloneReferenceInput(referenceInput.value),
      artistStyleIds: [...artistStyleIds.value],
    }
  }

  /** 回退到一组风格层快照（随机灵感撤销用）。 */
  function restoreStyleLayers(snapshot: ReturnType<typeof snapshotStyleLayers>) {
    randomVariation.value = snapshot.randomVariation ? JSON.parse(JSON.stringify(snapshot.randomVariation)) : null
    selections.emotion = [...(snapshot.emotions ?? [])]
    restoreDirectorState(snapshot, snapshot.directorSources)
    manualTags.value = new Set(snapshot.manualTags ?? [])
    referenceInput.value = cloneReferenceInput(snapshot.referenceInput)
    artistStyleIds.value = normalizeArtistStyleIds(snapshot.artistStyleIds)
  }

  // 2026-08-29 UX 收编：原生自绘 pb-toast 退役，统一走全局 useToast。
  function flash(msg: string, duration = 2500, type: 'info' | 'success' | 'warning' | 'error' = 'info') {
    toast.show(msg, type, duration)
  }

  // ── Data loading (single source via sceneStore) ───────────────────────
  function loadData(): Promise<void> {
    if (dataRequest) return dataRequest
    // Retain an earlier error during retry so its action and focus owner stay mounted.
    dataReady.value = false; dataLoading.value = true
    dataRequest = (async () => {
      try {
        await sceneStore.load()
        if (!sceneStore.loaded) throw new Error(sceneStore.error || '场景库暂时无法读取')
        // Required profiles and scenes must both settle before applying defaults.
        await sceneStore.loadPresetCatalog()
        const { parsePresetCatalog, fillMissingModelProfiles } = await import('@/utils/modelProfileDefaults')
        const catalog = parsePresetCatalog(sceneStore.presets)
        // Fill missing software profiles without replacing personal content.
        modelProfiles.value = await fillMissingModelProfiles(catalog.modelProfiles)
        applyModelProfile()
        dataError.value = ''; dataReady.value = true
      } catch (cause) {
        dataError.value = '创作资料暂时无法读取，请检查连接后重试。'
        throw cause
      } finally { dataLoading.value = false; dataRequest = null }
    })()
    return dataRequest
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

  const { snapshotDraft, saveDraft, restoreDraft, draftSaveState, draftSaveError, retryDraftSave } = usePromptDraft({ subject, storyOrigin, story, visualDescription, char, sceneId, activeScene, selections, colorMood, directorSources, inheritedDirectorValues, sceneBlueprints, loadPopularCharacter, manualTags, outfitOverride, referenceInput, randomVariation, artistStyleIds, sceneBaseStory, directorMode, sdParams, sdParamsTouched, projectId, scenes, lastRecommendedSize, dataReady, flash })

  /** Compatibility adapter for incomplete old inputs; the use case captures it before waiting. */
  function resolveLegacyArtworkDefaults(entry: GeneratedArtworkInput): LegacyArtworkDefaults {
    const currentSubject = entry.subject === 'popular'
      ? { kind: 'popular' as const, characterId: entry.characterId || '', outfitId: entry.outfitId || '', blueprintId: entry.blueprintId, outfitExplicit: entry.outfitExplicit }
      : entry.subject === 'studio' ? { kind: 'studio' as const } : subject.value
    const isPopular = currentSubject.kind === 'popular'
    const popChar = isPopular ? popularCharacters.value.find(c => c.id === currentSubject.characterId) : null
    const popBlueprint = isPopular && currentSubject.blueprintId
      ? sceneBlueprints.value.find(b => b.id === currentSubject.blueprintId) : null
    const sceneTitle = isPopular
      ? (popBlueprint?.title || (popChar ? `${popChar.displayName} 创作` : '热门角色作品'))
      : (activeScene.value?.title ?? (story.value ? story.value.slice(0, 20) : null))
    return {
      subject: currentSubject,
      character: isPopular ? (currentSubject.characterId || char.value) : char.value,
      scene: sceneId.value, sceneTitle, story: story.value, visualDescription: visualDescription.value,
      seed: lastSeed.value ?? -1,
      emotion: selections.emotion, shot: selections.shot, lighting: selections.lighting,
      composition: selections.composition, colorMood: colorMood.value, manual_tags: manualTags.value,
      directorSources: normalizeDirectorSources(directorSources.value),
      lora: loraLine.value || null, model: sdModelName.value, size: lastRecommendedSize.value,
      cfg: sdParams.cfg, steps: sdParams.steps, sampler: sdParams.sampler, scheduler: sdParams.scheduler,
      hiresFix: sdParams.hiresFix, hiresScale: sdParams.hiresScale, hiresUpscaler: sdParams.hiresUpscaler,
      hiresSteps: sdParams.hiresSteps, hiresDenoise: sdParams.hiresDenoise, faceDetailer: sdParams.faceDetailer,
      project: projectId.value, artistStyleIds: directorMode.value === 'pro' ? artistStyleIds.value : [],
    }
  }

  return {
    storyOrigin, story, visualDescription, char, colorMood, concise, sceneId, sceneBaseStory,
    selections, directorSources, inheritedDirectorValues, manualTags, tagDictionary, artistStyleIds, projectId, historyRestoreReport,
    subject, isPopular, isUnbound, outfitOverride, referenceInput, randomVariation,
    scenes, curation, loraMeta, modelProfiles, tags, characters,
    popularCharacters, sceneBlueprints, dataReady, dataLoading, dataError, loadPopularCharacter,
    popularBlueprintReady, popularBlueprintLoading, popularBlueprintError,
    history,
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
    saveDraft, restoreDraft, snapshotDraft, draftSaveState, draftSaveError, retryDraftSave,
    commitHistoryEntry, removeHistoryEntry, restoreHistoryEntry,
    sdParamsTouched, markParamTouched, applyModelProfile, resetParamsToProfile,
  }
})

import { usePromptDraft } from '@/composables/prompt/usePromptDraft'
import { usePromptSceneFilters } from '@/composables/prompt/usePromptSceneFilters'
import { usePromptArtworkHistory } from '@/composables/prompt/usePromptArtworkHistory'
import type { Scene } from '../types/scene'
export type { Scene } from '../types/scene'

import { defineStore } from 'pinia'
import type { GeneratedArtworkInput, LegacyArtworkDefaults } from '@/application/artwork/saveGeneratedArtwork'
import { ref, reactive, computed } from 'vue'
import { sceneLighting, sceneShot, sceneColorMood, sceneComposition, sceneRecommendedSize } from '@/utils/sceneInference'
import { type ModelProfile } from '@/utils/promptPolicy'
import { useSceneStore } from '@/stores/sceneStore'
import { applyModelProfileToParams } from '@/utils/promptModelProfile'
import { usePromptTags } from '@/composables/prompt/usePromptTags'
import { parsePromptScenes, parsePromptCharacters, parsePromptLoras, parsePromptTags } from '@/utils/promptCatalog'
import { useToast } from '@/composables/useToast'

const toast = useToast()

import {
  isSDParamKey,
  parsePresetCatalog,
  type PromptPreset,
  type SDParams,
} from '@/utils/promptBuilderPersistence'
import type { DrawSubject } from '@/utils/popularContent'
import { normalizeArtistStyleIds } from '@/config/artistStyles'

import type { CharKey, Selections } from '@/types/promptHistory'
export type { CharKey, DrawEngine, HistoryEntry, Selections } from '@/types/promptHistory'

export const SHOT_PROMPT: Record<string, string> = {
  close: 'close-up', medium: 'medium shot', wide: 'wide shot',
  pov: 'pov', low: 'low angle', high: 'high angle',
  side: 'side view', turn: 'looking back', over: 'selfie', detail: 'extreme close-up',
}

export const LIGHTING_PROMPT: Record<string, string> = {
  golden: 'golden hour', window: 'window light', back: 'backlighting',
  moon: 'moonlight', lantern: 'lantern', overcast: 'overcast',
}

export const COMPOSITION_PROMPT: Record<string, string> = {
  center: 'centered composition', rule3: 'rule of thirds',
  left: 'off-center composition', right: 'off-center composition',
  foreground: 'blurry foreground', frame: 'framed', bywindow: 'by window',
}

export const PROMPT_MAP_EMOTION: Record<string, string> = {
  happy: 'happy', shy: 'shy, blush', miss: 'wistful',
  expect: 'excited, sparkling eyes', nervous: 'nervous, blush', gentle: 'light smile',
  moved: 'teary_eyes', sad: 'sad', calm: 'calm', joyful: 'in_love, blush',
  relaxed: 'relaxed', serious: 'serious', love: 'in_love, blush',
  sleepy: 'sleepy', spoiled: 'pout', wronged: 'teary_eyes, pout',
}

export const CHAR_PROMPT: Record<string, string> = {
  // 单女主壁纸构图默认锁定 solo；互动场景只保留局部手/手臂，避免不稳定的第二人物抢占画面。
  nene: '1girl, solo, ayachi_nene, white_hair, very_long_hair, low_twintails, purple_eyes, ahoge, pink_hair_ribbons',
  natsume: '1girl, solo, shiki_natsume, black_hair, very_long_hair, yellow_eyes, mole_under_eye, hairclip',
  triad: '2girls',
}

export const NEGATIVE_DEFAULT = 'worst quality, low quality, normal quality, lowres, blurry, jpeg artifacts, text, watermark, logo, signature, bad anatomy, bad hands, extra fingers, missing fingers, extra arms, extra legs, deformed, cropped, duplicate'

export const RECOMMENDED_TAGS = [
  'golden_hour', 'window_light', 'soft_shadows', 'cinematic_composition',
  'depth_of_field', 'hair_blowing', 'beautiful_detailed_eyes',
  'warm_atmosphere', 'soft_colors', 'pastel_tones', 'muted_tones',
]

export const usePromptBuilderStore = defineStore('promptBuilder', () => {
  // ── Core director state ─────────────────────────────────────────────────
  const story     = ref('')
  const visualDescription = ref('')
  const char      = ref<CharKey>('nene')
  /** 热门角色无 LoRA 创作模式与工作室角色互斥；studio 路径继续用 char。 */
  const subject   = ref<DrawSubject>({ kind: 'studio' })
  const isPopular = computed(() => subject.value.kind === 'popular')
  const colorMood = ref<string | null>(null)
  const concise   = ref(false)
  const sceneId   = ref<string | null>(null)
  const sceneBaseStory = ref('')
  const selections = reactive<Selections>({ emotion: [], shot: null, lighting: null, composition: null })
  /**
   * 反推顶替的服装（2026-08-29）。非空时，热门角色用参考图服装**整体替换**
   * 角色默认服装（outfit.tokens + outfit.prose 一起换；只换 tag 不换散文无效）。
   * 清空即恢复角色默认服装。studio 路径（宁宁/夏目）不使用——它们无默认服装注入。
   */
  const outfitOverride = ref<{ tokens: string[]; replaced: string | null } | null>(null)
  const artistStyleIds = ref<string[]>([])
  const projectId  = ref('')

  // ── Loaded data (proxy to sceneStore, single source, no drift) ───────
  const sceneStore = useSceneStore()
  const { history, projects, commitHistoryEntry, removeHistoryEntry, restoreHistoryEntry, loadHistory, loadProjects } = usePromptArtworkHistory(resolveLegacyArtworkDefaults)
  const scenes = computed(() => parsePromptScenes(sceneStore.scenes))
  const curation = computed(() => sceneStore.curation)
  const loraMeta = computed(() => parsePromptLoras(sceneStore.loras))
  const tags = computed(() => parsePromptTags(sceneStore.tags))
  const { manualTags, tagDictionary, addManualTag, toggleManualTag } = usePromptTags(() => tags.value, flash)
  const characters = computed(() => parsePromptCharacters(sceneStore.characters))
  const popularCharacters = computed(() => sceneStore.popularCharacters)
  /** 当前主体对应的画师专属推荐（2026-09-05 从 PromptBuilderView 迁入：纯 store 派生）。 */
  const currentCuratedArtistStyles = computed<string[]>(() => {
    if (isPopular.value) {
      const charId = subject.value.kind === 'popular' ? subject.value.characterId : ''
      const current = popularCharacters.value.find(c => c.id === charId)
      return current?.curatedArtistStyles || []
    }
    // 工作室角色（宁宁 / 夏目 -> 柚子社画风 Kobuichi / Muririn / Kantoku）
    return ['kobuichi', 'muririn', 'kantoku']
  })
  const sceneBlueprints = computed(() => sceneStore.sceneBlueprints)
  const presets = ref<PromptPreset[]>([])
  const modelProfiles = ref<ModelProfile[]>([])
  const dataReady = ref(false)
  const historyRestoreReport = ref<{ title: string; notes: string[] } | null>(null)

  // ── SD state ────────────────────────────────────────────────────────────
  // 生成生命周期状态（online/generating/progress/result/error）由 useSDGenerate
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

  const { focusMode, directorMode, sceneSearch, sceneTheme, sceneLibMode, currentStep, showMatureScenes, activeTab, filteredScenes } = usePromptSceneFilters(scenes, char)
  const lastRecommendedSize = ref('832x1216')

  // ── Derived ─────────────────────────────────────────────────────────────
  const activeScene = computed(() =>
    sceneId.value ? scenes.value.find(s => s.id === sceneId.value) ?? null : null
  )

  const charPrompt = computed(() => CHAR_PROMPT[char.value] ?? '')

  const loraLine = computed(() => {
    if (!characters.value.length) return ''
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
  function setChar(c: CharKey) { char.value = c }
  function setStudioSubject() {
    if (subject.value.kind === 'studio') return
    subject.value = { kind: 'studio' }
    outfitOverride.value = null
  }
  function setPopularSubject(characterId: string, outfitId: string, blueprintId: string | null = null) {
    subject.value = { kind: 'popular', characterId, outfitId, blueprintId }
    // 换角色 / 换服装是一次明确的服装决策，清掉上一次反推留下的顶替
    outfitOverride.value = null
  }
  function setPopularBlueprint(blueprintId: string | null) {
    if (subject.value.kind !== 'popular') return
    subject.value = { kind: 'popular', characterId: subject.value.characterId, outfitId: subject.value.outfitId, blueprintId }
  }
  function setStory(t: string) { story.value = t }
  function toggleEmotion(id: string) {
    const i = selections.emotion.indexOf(id)
    if (i >= 0) selections.emotion.splice(i, 1); else selections.emotion.push(id)
  }
  function setShot(id: string | null)        { selections.shot = id }
  function setLighting(id: string | null)    { selections.lighting = id }
  function setComposition(id: string | null) { selections.composition = id }
  function setColorMood(id: string | null)   { colorMood.value = id }

  function setArtistStyleIds(ids: string[]) { artistStyleIds.value = normalizeArtistStyleIds(ids) }

  /** 反推出跨族服装：顶替角色默认服装（replaced 为被顶替的服装族名，用于提示）。 */
  function setOutfitOverride(tokens: string[], replaced: string | null) {
    outfitOverride.value = tokens.length ? { tokens: [...tokens], replaced } : null
  }
  /** 一键恢复角色默认服装。 */
  function clearOutfitOverride() { outfitOverride.value = null }

  function loadScene(scene: Scene) {
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
    manualTags.value = new Set()
    outfitOverride.value = null
    sdParams.negativeCustom = ''
    sdParamsTouched.value = new Set()
    // 推荐尺寸（优先场景显式字段，供视图书写）
    lastRecommendedSize.value = sceneRecommendedSize(scene)
  }

  function clearScene(opts: { keepStory?: boolean } = {}) {
    sceneId.value = null; sceneBaseStory.value = ''; visualDescription.value = ''; manualTags.value = new Set()
    outfitOverride.value = null
    selections.emotion = []; selections.shot = null; selections.lighting = null
    selections.composition = null; colorMood.value = null
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
      manualTags: [...manualTags.value],
      artistStyleIds: [...artistStyleIds.value],
    }
  }

  /** 回退到一组风格层快照（随机灵感撤销用）。 */
  function restoreStyleLayers(snapshot: ReturnType<typeof snapshotStyleLayers>) {
    selections.emotion = [...(snapshot.emotions ?? [])]
    selections.shot = snapshot.shot ?? null
    selections.lighting = snapshot.lighting ?? null
    selections.composition = snapshot.composition ?? null
    colorMood.value = snapshot.colorMood ?? null
    manualTags.value = new Set(snapshot.manualTags ?? [])
    artistStyleIds.value = normalizeArtistStyleIds(snapshot.artistStyleIds)
  }

  // 2026-08-29 UX 收编：原生自绘 pb-toast 退役，统一走全局 useToast。
  function flash(msg: string, duration = 2500, type: 'info' | 'success' | 'warning' | 'error' = 'info') {
    toast.show(msg, type, duration)
  }

  // ── Data loading (single source via sceneStore) ───────────────────────
  async function loadData() {
    await sceneStore.load()
    const catalog = parsePresetCatalog(sceneStore.presets)
    presets.value = catalog.presets
    modelProfiles.value = catalog.modelProfiles
    applyModelProfile()
    dataReady.value = true
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

  const { snapshotDraft, saveDraft, restoreDraft } = usePromptDraft({ subject, story, visualDescription, char, sceneId, activeScene, selections, colorMood, manualTags, artistStyleIds, sceneBaseStory, directorMode, sdParams, sdParamsTouched, projectId, scenes, lastRecommendedSize, dataReady, flash })

  /** Compatibility adapter for incomplete old inputs; the use case captures it before waiting. */
  function resolveLegacyArtworkDefaults(entry: GeneratedArtworkInput): LegacyArtworkDefaults {
    const currentSubject = entry.subject === 'popular'
      ? { kind: 'popular' as const, characterId: entry.characterId || '', outfitId: entry.outfitId || '', blueprintId: entry.blueprintId }
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
      lora: loraLine.value || null, model: sdModelName.value, size: lastRecommendedSize.value,
      cfg: sdParams.cfg, steps: sdParams.steps, sampler: sdParams.sampler, scheduler: sdParams.scheduler,
      hiresFix: sdParams.hiresFix, hiresScale: sdParams.hiresScale, hiresUpscaler: sdParams.hiresUpscaler,
      hiresSteps: sdParams.hiresSteps, hiresDenoise: sdParams.hiresDenoise, faceDetailer: sdParams.faceDetailer,
      project: projectId.value, artistStyleIds: directorMode.value === 'pro' ? artistStyleIds.value : [],
    }
  }

  return {
    story, visualDescription, char, colorMood, concise, sceneId, sceneBaseStory,
    selections, manualTags, tagDictionary, artistStyleIds, projectId, historyRestoreReport,
    subject, isPopular, outfitOverride,
    scenes, curation, loraMeta, presets, modelProfiles, tags, characters,
    popularCharacters, sceneBlueprints, dataReady,
    history, projects,
    sdModelName, lastSeed, sdParams,
    focusMode, directorMode, sceneSearch, sceneTheme, sceneLibMode,
    currentStep, showMatureScenes, activeTab, lastRecommendedSize,
    activeScene, charPrompt, loraLine, emotionPrompt, filteredScenes, currentCuratedArtistStyles,
    setChar, setStory, toggleEmotion, setShot, setLighting, setComposition,
    setColorMood, toggleManualTag, addManualTag, setArtistStyleIds, loadScene, clearScene, flash,
    setOutfitOverride, clearOutfitOverride,
    snapshotStyleLayers, restoreStyleLayers,
    setStudioSubject, setPopularSubject, setPopularBlueprint,
    loadData, loadHistory, loadProjects,
    saveDraft, restoreDraft, snapshotDraft,
    commitHistoryEntry, removeHistoryEntry, restoreHistoryEntry,
    sdParamsTouched, markParamTouched, applyModelProfile, resetParamsToProfile,
  }
})

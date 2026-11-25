import type { ComputedRef, Ref } from 'vue'
import type { StoryOrigin } from '@/types/storyOrigin'
import type { Scene } from '@/types/scene'
import type { CharKey, Selections } from '@/types/promptHistory'
import type { DirectorControlSources, DirectorControlValues } from '@/types/promptDirector'
import type { GeneratedArtworkInput, LegacyArtworkDefaults } from '@/application/artwork/artworkSaveInput'
import type {
  DraftOutfitOverride,
  DraftRandomVariation,
  DraftReferenceInput,
  SDParams,
} from '@/utils/promptBuilderPersistence'
import { cloneReferenceInput } from '@/utils/promptBuilderPersistence'
import type { DrawSubject, PopularCharacter, SceneBlueprint } from '@/utils/popularContent'
import { normalizeDirectorSources, sceneDirectorSources } from '@/utils/promptDirector'
import { sceneColorMood, sceneComposition, sceneLighting, sceneRecommendedSize, sceneShot } from '@/utils/sceneInference'
import { normalizeArtistStyleIds } from '@/config/artistStyles'

export function usePromptSceneOperations(params: {
  storyOrigin: Ref<StoryOrigin | undefined>
  story: Ref<string>
  visualDescription: Ref<string>
  char: Ref<CharKey>
  subject: Ref<DrawSubject>
  sceneId: Ref<string | null>
  sceneBaseStory: Ref<string>
  selections: Selections
  colorMood: Ref<string | null>
  directorSources: Ref<DirectorControlSources>
  manualTags: Ref<Set<string>>
  referenceInput: Ref<DraftReferenceInput | null>
  outfitOverride: Ref<DraftOutfitOverride | null>
  randomVariation: Ref<DraftRandomVariation | null>
  artistStyleIds: Ref<string[]>
  sdParams: SDParams
  sdParamsTouched: Ref<Set<keyof SDParams>>
  sdModelName: Ref<string>
  lastSeed: Ref<number | null>
  lastRecommendedSize: Ref<string>
  projectId: Ref<string>
  directorMode: Ref<'basic' | 'pro'>
  activeScene: ComputedRef<Scene | null>
  loraLine: ComputedRef<string>
  popularCharacters: ComputedRef<PopularCharacter[]>
  sceneBlueprints: ComputedRef<SceneBlueprint[]>
  restoreDirectorState: (values: DirectorControlValues, sources: unknown) => void
}) {
  const {
    storyOrigin, story, visualDescription, char, subject, sceneId, sceneBaseStory,
    selections, colorMood, directorSources, manualTags, referenceInput, outfitOverride,
    randomVariation, artistStyleIds, sdParams, sdParamsTouched, sdModelName, lastSeed,
    lastRecommendedSize, projectId, directorMode, activeScene, loraLine,
    popularCharacters, sceneBlueprints, restoreDirectorState,
  } = params

  function loadScene(scene: Scene) {
    storyOrigin.value = undefined
    randomVariation.value = null
    // 工作室场景天然属于 studio 组装分支：热门角色(popular)模式下用 ?scene= 深链
    // （灵感场景/全景搜索/历史恢复）切回宁宁或夏目场景时，若不把 subject 兜底回
    // studio，isPopular 仍为 true，livePrompt 会继续走 usePopularPromptAssembly，
    // 提示词仍是上一个热门角色的、不会跟随本场景（2026 真机复现）。
    subject.value = { kind: 'studio' }
    sceneId.value = scene.id
    sceneBaseStory.value = scene.story ?? ''
    story.value = scene.story ?? story.value
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
    loadScene,
    clearScene,
    snapshotStyleLayers,
    restoreStyleLayers,
    resolveLegacyArtworkDefaults,
  }
}

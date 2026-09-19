import { computed, ref, type Ref } from 'vue'
import type { Scene } from '@/stores/promptBuilderStore'
import { useDirectorDerived } from '@/composables/scene/useDirectorDerived'
import { useDirectorPopular, type UseDirectorPopularInput } from '@/composables/scene/useDirectorPopular'
import { readHiddenScenes, recordSceneUsage, rememberRecent } from '@/utils/sceneUX'

export type SceneCollection = 'core' | 'curated' | 'all'
export type VoiceStudioHandle = { setSuggestedCaption?: (caption: string) => void }

interface PromptMaterialsInput extends UseDirectorPopularInput {
  voiceStudioRef: Ref<VoiceStudioHandle | null>
}

/** Owns material browsing and selection; scene/character business state stays in the store. */
export function usePromptMaterials(input: PromptMaterialsInput) {
  const { pb, sd, sdSize, drawEngine, setDrawEngine, applyRecommendedSize, patchAnimaState, refreshAnimaBackend, voiceStudioRef, animaState, generationBusy } = input
  const sceneLimit = ref(20)
  const sceneCollection = ref<SceneCollection>('core')
  const hiddenSceneIds = ref(readHiddenScenes())
  const derived = useDirectorDerived({ pb, hiddenSceneIds, sceneCollection, sceneLimit, sdSize })
  const popular = useDirectorPopular(input)

  function setDirectorMode(mode: 'basic' | 'pro') {
    pb.directorMode = mode
    sceneCollection.value = mode === 'basic' ? 'core' : 'all'
    sceneLimit.value = 20
    popular.syncManagedRoute()
  }
  function setSceneCollection(collection: SceneCollection) {
    if (collection === 'all' && pb.directorMode === 'basic') {
      setDirectorMode('pro')
      return
    }
    sceneCollection.value = collection
    sceneLimit.value = 20
  }
  function selectScene(scene: Scene) {
    // Refresh the studio model whitelist immediately when leaving a popular character.
    if (pb.isPopular) void refreshAnimaBackend()
    pb.loadScene(scene)
    pb.applyModelProfile(pb.sdModelName || sd.checkpoint.value, { applySize: false })
    applyRecommendedSize(pb.lastRecommendedSize)
    patchAnimaState({ styleLoraId: '' })
    voiceStudioRef.value?.setSuggestedCaption?.(scene.story ?? '')
    rememberRecent(scene)
    recordSceneUsage(scene)
    sceneLimit.value = 20
    popular.syncManagedRoute()
  }
  const currentBlueprintData = computed(() => ({
    ...pb.snapshotDraft(),
    outfitOverride: pb.outfitOverride ? { tokens: [...pb.outfitOverride.tokens], replaced: pb.outfitOverride.replaced } : null,
    drawEngine: drawEngine.value,
    size: drawEngine.value === 'sd' ? sdSize.value : `${animaState.value.width}x${animaState.value.height}`,
    anima: {
      modelId: animaState.value.modelId, loraId: animaState.value.loraId,
      loraStrength: animaState.value.loraStrength, styleLoraId: animaState.value.styleLoraId,
      width: animaState.value.width, height: animaState.value.height,
      steps: animaState.value.steps, cfg: animaState.value.cfg,
      sampler: animaState.value.sampler, scheduler: animaState.value.scheduler,
      seed: animaState.value.seed, hiresFix: animaState.value.hiresFix,
      hiresScale: animaState.value.hiresScale, hiresDenoise: animaState.value.hiresDenoise,
      teaCache: animaState.value.teaCache, teaCacheThresh: animaState.value.teaCacheThresh,
    },
  }))
  async function handleLoadBlueprint(data: Record<string, unknown>) {
    if (generationBusy.value) { pb.flash('生成进行中，完成或停止后再载入蓝图'); return }
    const { loadBlueprint } = await import('./promptBlueprintActions')
    const result = await loadBlueprint(data, {
      pb, selectScene, setDrawEngine, sdSize, setDirectorMode,
      selectPopularSource: popular.selectPopularSource, selectBlueprint: popular.selectBlueprint,
      applyRecommendedSize, refreshAnimaBackend, animaState, patchAnimaState,
    })
    pb.flash(result.applied
      ? `${result.message}${result.warnings.length ? `（${result.warnings.join('；')}）` : ''}`
      : `蓝图未载入：${result.message}`)
  }

  return {
    derived, popular, sceneLimit, sceneCollection,
    setDirectorMode, setSceneCollection, selectScene, currentBlueprintData, handleLoadBlueprint,
  }
}

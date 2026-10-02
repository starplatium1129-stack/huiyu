import { computed, ref, onActivated, onDeactivated, onScopeDispose, getCurrentInstance, type Ref } from 'vue'
import type { Scene } from '@/stores/promptBuilderStore'
import { useDirectorDerived } from '@/composables/scene/useDirectorDerived'
import { useDirectorPopular, type UseDirectorPopularInput } from '@/composables/scene/useDirectorPopular'
import { readHiddenScenes, recordSceneUsage, rememberRecent } from '@/utils/sceneUX'
import { applyGeneratedSceneSettings } from '@/composables/scene/applyGeneratedSceneSettings'

export type SceneCollection = 'core' | 'curated' | 'all'
export type VoiceStudioHandle = { setSuggestedCaption?: (caption: string) => void }

interface PromptMaterialsInput extends UseDirectorPopularInput {
  voiceStudioRef: Ref<VoiceStudioHandle | null>
  getAnimaSettingsRevision?: () => number
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
    if (generationBusy.value) { pb.flash('生成进行中，完成或停止后再载入场景'); return }
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
    if (scene.generatedRecipe) {
      try { pb.flash(`已载入生成场景；${applyGeneratedSceneSettings(scene.generatedRecipe, input).join('；')}`, 9000) }
      catch (error) { pb.flash(error instanceof Error ? error.message : '生成配方无法载入', 9000, 'warning') }
    }
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
  let blueprintRevision = 0, blueprintActive = true
  const stopBlueprint = () => { blueprintActive = false; blueprintRevision++ }
  if (getCurrentInstance()) {
    onActivated(() => { blueprintActive = true })
    onDeactivated(stopBlueprint)
  }
  onScopeDispose(stopBlueprint)
  async function handleLoadBlueprint(data: Record<string, unknown>, signal?: AbortSignal) {
    const revision = ++blueprintRevision
    const current = () => blueprintActive && revision === blueprintRevision && !signal?.aborted && !generationBusy.value
    if (!blueprintActive || signal?.aborted) return
    if (generationBusy.value) { pb.flash('生成进行中，完成或停止后再载入蓝图'); return }
    const fingerprint = () => { const { updatedAt: _updatedAt, ...draft } = currentBlueprintData.value; return JSON.stringify(draft) }
    const before = fingerprint()
    try {
      const { loadBlueprint } = await import('./promptBlueprintActions')
      if (!current() || before !== fingerprint()) return
      const result = await loadBlueprint(data, {
        pb, selectScene, setDrawEngine, sdSize, setDirectorMode, isCurrent: current, getDrawEngine: () => drawEngine.value, getAnimaSettingsRevision: input.getAnimaSettingsRevision,
        selectPopularSource: popular.selectPopularSource, selectBlueprint: popular.selectBlueprint,
        applyRecommendedSize, refreshAnimaBackend, animaState, patchAnimaState,
      })
      if (!current()) return
      pb.flash(result.applied
        ? `${result.message}${result.warnings.length ? `（${result.warnings.join('；')}）` : ''}`
        : `蓝图未载入：${result.message}`)
    } catch { if (current()) pb.flash('蓝图载入中断，请核对当前草稿后重试') }
  }

  return {
    derived, popular, sceneLimit, sceneCollection,
    setDirectorMode, setSceneCollection, selectScene, currentBlueprintData, handleLoadBlueprint,
  }
}

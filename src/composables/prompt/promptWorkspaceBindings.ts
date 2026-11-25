import { computed, reactive, toRef, type ComputedRef, type Ref } from 'vue'
import type { AnimaCompositionBindings } from '@/composables/generation/useAnimaComposition'
import type { useAnimaInpaint } from '@/composables/generation/useAnimaInpaint'
import type { useAnimaSession } from '@/composables/generation/useAnimaSession'
import type { useLegacySdTasks } from '@/composables/generation/useLegacySdTasks'
import type { useDirectorEngine } from '@/composables/scene/useDirectorEngine'
import type { useCompareSnapshots } from '@/composables/useCompareSnapshots'
import type { useUnifiedPromptAssembly } from '@/composables/useUnifiedPromptAssembly'
import type { DrawEngine } from '@/storage/settingsRepository'
import type { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import type { useSceneStore } from '@/stores/sceneStore'
import type { GenerationPresentation } from './useGenerationPresentation'
import type { usePromptMaterials, VoiceStudioHandle } from './usePromptMaterials'
import type { PromptBatchRunnersDeps } from './usePromptBatchRunners'
import type {
  PromptDeliveryBindings,
  PromptDialogBindings,
  PromptHealthBindings,
  PromptMaterialBindings,
  PromptRenderBindings,
  PromptStyleBindings,
} from './promptPanelBindings'
import { BUSY_HINT } from './usePromptRenderControls'
import type { ResultSnapshot } from './promptResultSnapshot'
import type { usePromptSdQueue } from './usePromptSdQueue'

type Store = ReturnType<typeof usePromptBuilderStore>
type SceneStore = ReturnType<typeof useSceneStore>
type Anima = ReturnType<typeof useAnimaSession>
type Engine = ReturnType<typeof useDirectorEngine>
type Materials = ReturnType<typeof usePromptMaterials>
type Queue = ReturnType<typeof usePromptSdQueue>
type Assembly = ReturnType<typeof useUnifiedPromptAssembly>
type Inpaint = ReturnType<typeof useAnimaInpaint>
type Compare = ReturnType<typeof useCompareSnapshots<ResultSnapshot>>
type LegacySd = ReturnType<typeof useLegacySdTasks>

export interface PromptWorkspaceBindingsDeps {
  pb: Store
  sceneStore: SceneStore
  sd: LegacySd
  drawEngine: Ref<DrawEngine>
  currentCharacterId: Readonly<Ref<string>>
  animaSession: Anima
  engine: Engine
  generationBusy: ComputedRef<boolean>
  generationPresentation: Readonly<Ref<GenerationPresentation>>
  unified: Assembly
  materials: Materials
  sdQueue: Queue['sdQueue']
  runJob: Queue['runJob']
  inpaint: Pick<Inpaint, 'inpaintOpen' | 'inpaintCharacter' | 'handleInpaintSubmit'>
  compare: Pick<Compare, 'prevResult' | 'lastResult' | 'compareOpen' | 'close'>
  displayedResultHistoryId: Readonly<Ref<string | number | null>>
  inpaintPreparing: Ref<boolean>
  compositionPreparing: Ref<boolean>
  cancelCompositionPreparation: Ref<(() => void) | null>
  voiceStudioRef: Ref<VoiceStudioHandle | null>
  autoSaveToGallery: Ref<boolean>
  batchRunning: Ref<boolean>
  batchOpen: Ref<boolean>
  engineTitle: (engine: DrawEngine) => string | undefined
  resetSdParams: () => void
  reuseSuccessfulRecipe: (id: string | number) => Promise<void>
  reuseLastSeed: () => void
  retryAnima: () => void
  onArtistLimitReached: (max: number) => void
  copyPrompt: () => Promise<boolean>
  queuePausedReason: Readonly<Ref<string>>
  retryInitialization: () => Promise<void>
}

/** Projects workspace state into explicit per-panel capability contracts. */
export function createPromptWorkspaceBindings(deps: PromptWorkspaceBindingsDeps) {
  const {
    pb, sceneStore, sd, drawEngine, currentCharacterId, animaSession, engine,
    generationBusy, generationPresentation, unified, materials, sdQueue, runJob,
    inpaint, compare, displayedResultHistoryId, inpaintPreparing, compositionPreparing,
    cancelCompositionPreparation, voiceStudioRef, autoSaveToGallery, batchRunning, batchOpen,
    engineTitle, resetSdParams, reuseSuccessfulRecipe, reuseLastSeed, retryAnima,
    onArtistLimitReached, copyPrompt, queuePausedReason, retryInitialization,
  } = deps

  const animaState = animaSession.state

  // ── 多场景批量出图（编排由 BatchSceneDrawPanel 持有，宿主只注入依赖快照）──
  const batchPanelDeps: PromptBatchRunnersDeps = {
    pb,
    sd,
    negativePrompt: unified.negativePrompt,
    animaState,
    runJob,
    sceneBlueprints: () => sceneStore.sceneBlueprints,
    scenes: () => pb.scenes,
    currentPlan: () => unified.structuredPlan.value,
    popularCharacters: () => sceneStore.popularCharacters,
    currentLivePrompt: () => unified.positivePrompt.value,
  }

  const compositionBindings: AnimaCompositionBindings = {
    state: animaState,
    busy: generationBusy,
    preparing: compositionPreparing,
    cancelPreparation: cancelCompositionPreparation,
    contextKey: computed(() => JSON.stringify([drawEngine.value, currentCharacterId.value, pb.projectId, animaState.value.modelId, animaState.value.width, animaState.value.height])),
    capture: animaSession.captureSubmission,
    generate: animaSession.generate,
    flash: message => pb.flash(message),
  }

  // Each lazy panel receives a stable, explicit capability surface. Store fields are
  // projected with toRef, so writes still reach the single existing state owner.
  const materialBindings: PromptMaterialBindings = {
    popularBlueprintPool: materials.popular.popularBlueprintPool,
    blueprintCategories: materials.popular.blueprintCategories,
    recommendedBlueprints: materials.popular.recommendedBlueprints,
    filteredPopularBlueprints: materials.popular.filteredPopularBlueprints,
    popularCategory: materials.popular.popularCategory,
    showAllBlueprints: materials.popular.showAllBlueprints,
    availableScenes: materials.derived.availableScenes,
    visibleScenes: materials.derived.visibleScenes,
    sceneCollection: materials.sceneCollection,
    personaCoreCount: materials.derived.personaCoreCount,
    curatedCount: materials.derived.curatedCount,
    personaCoreIds: materials.derived.personaCoreIds,
    sceneLimit: materials.sceneLimit,
    selectBlueprint: materials.popular.selectBlueprint,
    rotateBlueprintSet: materials.popular.rotateBlueprintSet,
    toggleBlueprintList: materials.popular.toggleBlueprintList,
    setSceneCollection: materials.setSceneCollection,
    selectScene: materials.selectScene,
    retryInitialization,
  }

  const renderBindings: PromptRenderBindings = {
    pb: reactive({
      directorMode: toRef(pb, 'directorMode'),
      history: toRef(pb, 'history'),
      subject: toRef(pb, 'subject'),
      isPopular: toRef(pb, 'isPopular'),
      char: toRef(pb, 'char'),
      visualDescription: toRef(pb, 'visualDescription'),
      castRequiresNoLora: toRef(pb, 'castRequiresNoLora'),
      sdModelName: toRef(pb, 'sdModelName'),
      sdParams: toRef(pb, 'sdParams'),
      markParamTouched: pb.markParamTouched,
    }),
    displayResultUrl: engine.displayResultUrl,
    generationBusy,
    generationPresentation,
    animaState,
    drawEngine,
    generationPresetSummary: engine.generationPresetSummary,
    managedRoute: materials.popular.managedRoute,
    applyManagedRoute: materials.popular.applyManagedRoute,
    reuseSuccessfulRecipe,
    engineTitle,
    setDrawEngine: engine.setDrawEngine,
    supportsDualCharacter: engine.supportsDualCharacter,
    currentCapabilities: engine.currentCapabilities,
    BUSY_HINT,
    selectAnimaModel: engine.selectAnimaModel,
    displayResultSeed: engine.displayResultSeed,
    reuseLastSeed,
    resetSdParams,
    animaNoLoraMode: engine.animaNoLoraMode,
    patchAnimaState: animaSession.patchState,
    refreshAnimaBackend: animaSession.refreshBackend,
    retryAnima,
    vramHint: materials.derived.vramHint,
    vramLevel: materials.derived.vramLevel,
    baseResolutionRisk: materials.derived.baseResolutionRisk,
    baseResolutionHint: materials.derived.baseResolutionHint,
    canUseFaceDetailer: materials.derived.canUseFaceDetailer,
  }

  const styleBindings: PromptStyleBindings = {
    pb: reactive({
      directorMode: toRef(pb, 'directorMode'),
      artistStyleIds: toRef(pb, 'artistStyleIds'),
      currentCuratedArtistStyles: toRef(pb, 'currentCuratedArtistStyles'),
      setArtistStyleIds: pb.setArtistStyleIds,
    }),
    drawEngine,
    onArtistLimitReached,
  }

  const healthBindings: PromptHealthBindings = {
    pb: reactive({
      directorMode: toRef(pb, 'directorMode'),
      isPopular: toRef(pb, 'isPopular'),
      manualTags: toRef(pb, 'manualTags'),
    }),
    structuredPlan: unified.structuredPlan,
    previewPromptView: unified.previewPrompt,
    previewContext: unified.previewContext,
    modelProfileView: unified.modelProfile,
    reportView: unified.promptReport,
    artViolationsView: unified.artViolations,
    loraSpecs: unified.studio.loraSpecs,
    copyPrompt,
    saveDraft: pb.saveDraft,
  }

  const deliveryBindings: PromptDeliveryBindings = {
    pb: reactive({
      char: toRef(pb, 'char'),
      activeScene: toRef(pb, 'activeScene'),
      story: toRef(pb, 'story'),
    }),
    voiceStudioRef,
    legacyProgress: computed(() => sd.progress.value === null ? null : sd.progress.value / 100),
    animaOnline: computed(() => animaState.value.online),
    scenes: toRef(sceneStore, 'sceneBlueprints'),
    generationBusy,
    sdQueue: {
      total: sdQueue.total,
      done: sdQueue.done,
      paused: sdQueue.paused,
      activeJob: sdQueue.activeJob,
      queue: sdQueue.queue,
      pause: sdQueue.pause,
      resume: sdQueue.resume,
      clear: sdQueue.clear,
      remove: sdQueue.remove,
    },
    BUSY_HINT,
    autoSaveToGallery,
    batchRunning,
    batchOpen,
    queuePausedReason,
    batchPanelDeps,
  }

  const dialogBindings: PromptDialogBindings = {
    inpaintProvider: computed(() => animaState.value.provider),
    inpaintManagedStartAvailable: computed(() => animaState.value.managedStartAvailable === true),
    inpaintAutomaticMaskAvailable: computed(() => animaState.value.automaticMaskAvailable === true),
    inpaintAutomaticMaskStatus: computed(() => animaState.value.automaticMaskStatus),
    inpaintImageSource: computed(() => ({
      url: engine.displayResultUrl.value,
      blob: animaState.value.result?.blob,
      historyId: displayedResultHistoryId.value,
    })),
    generationBusy,
    inpaintPreparing,
    prevResult: compare.prevResult,
    inpaintOpen: inpaint.inpaintOpen,
    compareOpen: compare.compareOpen,
    displayResultSeed: engine.displayResultSeed,
    lastResult: compare.lastResult,
    closeCompare: compare.close,
    negativePrompt: unified.studio.negativePrompt,
    inpaintCharacter: inpaint.inpaintCharacter,
    handleInpaintSubmit: inpaint.handleInpaintSubmit,
  }

  return {
    batchPanelDeps,
    compositionBindings,
    materialBindings,
    renderBindings,
    styleBindings,
    healthBindings,
    deliveryBindings,
    dialogBindings,
  }
}

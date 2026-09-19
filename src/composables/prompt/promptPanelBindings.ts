import type { Ref } from 'vue'
import type { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import type { useSDGenerate } from '@/composables/generation/useSDGenerate'
import type { useAnimaSession } from '@/composables/generation/useAnimaSession'
import type { useAnimaInpaint } from '@/composables/generation/useAnimaInpaint'
import type { useDirectorEngine } from '@/composables/scene/useDirectorEngine'
import type { useDirectorDerived } from '@/composables/scene/useDirectorDerived'
import type { useDirectorPopular } from '@/composables/scene/useDirectorPopular'
import type { useUnifiedPromptAssembly } from '@/composables/useUnifiedPromptAssembly'
import type { useCompareSnapshots } from '@/composables/useCompareSnapshots'
import type { DrawEngine } from '@/storage/settingsRepository'
import type { SDRecoveryId } from '@/utils/sdError'
import type { usePromptMaterials, VoiceStudioHandle } from './usePromptMaterials'
import type { usePromptSdQueue } from './usePromptSdQueue'
import type { useTempResult } from './useTempResult'
import type { PromptBatchRunnersDeps } from './usePromptBatchRunners'
import type { ResultSnapshot } from './promptResultSnapshot'

type Store = ReturnType<typeof usePromptBuilderStore>
type Sd = ReturnType<typeof useSDGenerate>
type Anima = ReturnType<typeof useAnimaSession>
type Engine = ReturnType<typeof useDirectorEngine>
type Derived = ReturnType<typeof useDirectorDerived>
type Popular = ReturnType<typeof useDirectorPopular>
type Materials = ReturnType<typeof usePromptMaterials>
type Queue = ReturnType<typeof usePromptSdQueue>
type TempResult = ReturnType<typeof useTempResult>
type Assembly = ReturnType<typeof useUnifiedPromptAssembly>
type Inpaint = ReturnType<typeof useAnimaInpaint>
type Compare = ReturnType<typeof useCompareSnapshots<ResultSnapshot>>

/** Ref identities are shared with their owners; each async panel receives only its own contract. */
export interface PromptMaterialBindings extends
  Pick<Derived, 'availableScenes' | 'visibleScenes' | 'personaCoreCount' | 'curatedCount' | 'personaCoreIds'>,
  Pick<Popular, 'popularBlueprintPool' | 'blueprintCategories' | 'recommendedBlueprints' | 'filteredPopularBlueprints' | 'popularCategory' | 'showAllBlueprints' | 'selectBlueprint' | 'rotateBlueprintSet' | 'toggleBlueprintList'>,
  Pick<Materials, 'sceneCollection' | 'sceneLimit' | 'setSceneCollection' | 'selectScene'> {}

export interface PromptRenderBindings extends
  Pick<Engine, 'displayResultUrl' | 'generationBusy' | 'generationPresetSummary' | 'setDrawEngine' | 'supportsDualCharacter' | 'selectAnimaModel' | 'displayResultSeed' | 'animaNoLoraMode'>,
  Pick<Popular, 'managedRoute' | 'applyManagedRoute'>,
  Pick<Derived, 'vramHint' | 'vramLevel' | 'baseResolutionRisk' | 'baseResolutionHint' | 'canUseFaceDetailer'>,
  Pick<Queue, 'enqueueCurrent' | 'enqueue3Variants'> {
  pb: Pick<Store, 'directorMode' | 'history' | 'subject' | 'isPopular' | 'char' | 'sdModelName' | 'sdParams' | 'markParamTouched'>
  sd: Pick<Sd, 'models' | 'samplers' | 'schedulers'>
  sdQueue: Pick<Queue['sdQueue'], 'canEnqueue'>
  drawEngine: Ref<DrawEngine>
  animaState: Anima['state']
  patchAnimaState: Anima['patchState']
  engineTitle: (engine: DrawEngine) => string | undefined
  BUSY_HINT: string
  reuseSuccessfulRecipe: (id: string | number) => Promise<void>
  upscaleCurrentResult: () => Promise<void>
  reuseLastSeed: () => void
  resetSdParams: () => void
  retryAnima: () => void
  resetAll: () => Promise<void>
}

export interface PromptStyleBindings extends Pick<Derived, 'emotionSummary' | 'shotSummary' | 'lightingSummary' | 'compositionSummary' | 'moodSummary'> {
  pb: Pick<Store, 'directorMode' | 'artistStyleIds' | 'currentCuratedArtistStyles' | 'setArtistStyleIds'>
  drawEngine: Ref<DrawEngine>
  onArtistLimitReached: (max: number) => void
}

export interface PromptHealthBindings {
  pb: Pick<Store, 'directorMode' | 'isPopular'>
  previewPromptView: Assembly['previewPrompt']
  modelProfileView: Assembly['modelProfile']
  reportView: Assembly['promptReport']
  artViolationsView: Assembly['artViolations']
  loraSpecs: Assembly['studio']['loraSpecs']
  copyPrompt: () => Promise<void>
  saveCurrentResult: TempResult['saveCurrentResult']
}

export interface PromptDeliveryBindings extends Pick<Engine, 'generationBusy' | 'generationProgress'>,
  Pick<Queue, 'sdErrorReport' | 'dismissError'> {
  pb: Pick<Store, 'char' | 'activeScene' | 'story'>
  voiceStudioRef: Ref<VoiceStudioHandle | null>
  drawEngine: Ref<DrawEngine>
  sdOnline: Sd['online']
  animaOnline: Readonly<Ref<boolean>>
  scenes: Readonly<Ref<ReturnType<PromptBatchRunnersDeps['sceneBlueprints']>>>
  shotsPending: Ref<number>
  goToShots: () => Promise<void>
  sdQueue: Pick<Queue['sdQueue'], 'total' | 'done' | 'paused' | 'activeJob' | 'queue' | 'pause' | 'resume' | 'clear' | 'remove'>
  BUSY_HINT: string
  autoSaveToGallery: Ref<boolean>
  batchRunning: Ref<boolean>
  batchOpen: Ref<boolean>
  runRecovery: (id: SDRecoveryId) => Promise<void>
  queuePausedReason: Readonly<Ref<string>>
  batchPanelDeps: PromptBatchRunnersDeps
}

export interface PromptDialogBindings extends Pick<Engine, 'displayResultUrl' | 'displayResultSeed' | 'generationBusy'>,
  Pick<Inpaint, 'inpaintOpen' | 'inpaintCharacter' | 'handleInpaintSubmit'>,
  Pick<Compare, 'compareEl' | 'prevResult' | 'lastResult' | 'compareOpen'> {
  adultEnabled: Readonly<Ref<boolean>>
  resultBlob: Readonly<Ref<Blob | null | undefined>>
  livePrompt: Assembly['positivePrompt']
  negativePrompt: Assembly['studio']['negativePrompt']
  closeCompare: Compare['close']
}

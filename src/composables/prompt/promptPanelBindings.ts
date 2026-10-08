import type { Ref } from 'vue'
import type { InpaintSource } from '@/components/inpaint/useInpaintImageSource'
import type { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import type { useLegacySdTasks } from '@/composables/generation/useLegacySdTasks'
import type { useAnimaSession } from '@/composables/generation/useAnimaSession'
import type { useAnimaInpaint } from '@/composables/generation/useAnimaInpaint'
import type { useDirectorEngine } from '@/composables/scene/useDirectorEngine'
import type { useDirectorDerived } from '@/composables/scene/useDirectorDerived'
import type { useDirectorPopular } from '@/composables/scene/useDirectorPopular'
import type { useUnifiedPromptAssembly } from '@/composables/useUnifiedPromptAssembly'
import type { useCompareSnapshots } from '@/composables/useCompareSnapshots'
import type { DrawEngine } from '@/storage/settingsRepository'
import type { usePromptMaterials, VoiceStudioHandle } from './usePromptMaterials'
import type { usePromptSdQueue } from './usePromptSdQueue'
import type { useTempResult } from './useTempResult'
import type { PromptBatchRunnersDeps } from './usePromptBatchRunners'
import type { ResultSnapshot } from './promptResultSnapshot'

type Store = ReturnType<typeof usePromptBuilderStore>
type Sd = ReturnType<typeof useLegacySdTasks>
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
  Pick<Derived, 'vramHint' | 'vramLevel' | 'baseResolutionRisk' | 'baseResolutionHint' | 'canUseFaceDetailer'> {
  pb: Pick<Store, 'directorMode' | 'history' | 'subject' | 'isPopular' | 'char' | 'visualDescription' | 'sdModelName' | 'sdParams' | 'markParamTouched'>
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
}

export interface PromptStyleBindings {
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

export interface PromptDeliveryBindings extends Pick<Engine, 'generationBusy' | 'generationProgress'> {
  pb: Pick<Store, 'char' | 'activeScene' | 'story'>
  voiceStudioRef: Ref<VoiceStudioHandle | null>
  drawEngine: Ref<DrawEngine>
  legacyProgress: Readonly<Ref<number | null>>
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
  queuePausedReason: Readonly<Ref<string>>
  batchPanelDeps: PromptBatchRunnersDeps
}

export interface PromptDialogBindings extends Pick<Engine, 'displayResultUrl' | 'displayResultSeed' | 'generationBusy'>,
  Pick<Inpaint, 'inpaintOpen' | 'inpaintCharacter' | 'handleInpaintSubmit'>,
  Pick<Compare, 'compareEl' | 'prevResult' | 'lastResult' | 'compareOpen'> {
  adultEnabled: Readonly<Ref<boolean>>
  inpaintPreparing: Readonly<Ref<boolean>>
  inpaintImageSource: Readonly<Ref<InpaintSource>>
  livePrompt: Assembly['positivePrompt']
  negativePrompt: Assembly['studio']['negativePrompt']
  closeCompare: Compare['close']
}

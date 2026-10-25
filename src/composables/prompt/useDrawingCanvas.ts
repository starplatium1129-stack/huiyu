import { computed } from 'vue'
import type { usePromptWorkspace } from './usePromptWorkspace'
import { useNativeDrawing } from './useNativeDrawing'

/** One canvas and action bar; each generation session keeps its own parameters and results. */
export function useDrawingCanvas(workspace: ReturnType<typeof usePromptWorkspace>) {
  const native = useNativeDrawing(workspace), enabled = computed(() => !!native.mode.value)
  const state = native.session
  return { ...workspace, native,
    displayResultUrl: computed(() => enabled.value ? state.value?.resultUrl.value || '' : workspace.displayResultUrl.value),
    resultRevealUrl: computed(() => enabled.value ? state.value?.resultUrl.value || '' : workspace.resultRevealUrl.value),
    drawEngine: computed(() => native.mode.value || workspace.drawEngine.value),
    drawEngineLabel: computed(() => native.mode.value === 'moss' ? 'MiaoMiao MOSS' : native.mode.value === 'qwen' ? 'Qwen' : workspace.drawEngineLabel.value),
    engineOnline: computed(() => enabled.value ? !!state.value?.selected.value?.available : workspace.engineOnline.value),
    engineConnected: computed(() => enabled.value ? !!state.value?.selected.value?.available : workspace.animaState.value.online),
    engineStatusText: computed(() => enabled.value ? state.value?.statusError.value || state.value?.selected.value?.unavailableReason || '原生模型待准备' : workspace.engineStatusText.value),
    generationBusy: computed(() => workspace.generationBusy.value || native.busy.value),
    generationError: computed(() => enabled.value ? state.value?.error.value || '' : workspace.generationError.value),
    generationStopped: computed(() => enabled.value ? state.value?.task.value?.status === 'cancelled' : workspace.generationStopped.value),
    generationPresentation: computed(() => enabled.value ? native.presentation.value : workspace.generationPresentation.value),
    generateBlockReason: computed(() => enabled.value ? native.blocked.value : workspace.generateBlockReason.value),
    genBarSize: computed({ get: () => enabled.value ? native.size.value : workspace.genBarSize.value,
      set: value => { if (enabled.value) native.size.value = value; else workspace.genBarSize.value = value } }),
    animaBarSizes: computed(() => enabled.value ? native.sizes.value : workspace.animaBarSizes.value),
    resultArchived: computed(() => enabled.value ? state.value?.result.value ? state.value.saved.value : null : workspace.resultArchived.value),
    savingResult: computed(() => enabled.value ? !!state.value?.saving.value : workspace.savingResult.value),
    resultTemporary: computed(() => enabled.value ? !!state.value?.result.value && !state.value.saved.value : workspace.resultTemporary.value),
    prevResult: computed(() => enabled.value ? null : workspace.prevResult.value),
    hasStashedResult: computed(() => !enabled.value && workspace.hasStashedResult.value),
    inpaintOriginalUrl: computed(() => enabled.value ? null : workspace.inpaintOriginalUrl.value),
    inpaintCompareActive: computed({ get: () => !enabled.value && workspace.inpaintCompareActive.value,
      set: value => { if (!enabled.value) workspace.inpaintCompareActive.value = value } }),
    callGenerate: () => enabled.value ? native.generate() : workspace.callGenerate(),
    cancelGeneration: () => enabled.value ? state.value?.cancel() : workspace.cancelGeneration(),
    recheckEngineConnection: () => enabled.value ? state.value?.refresh() : workspace.recheckEngineConnection(),
    saveResult: () => enabled.value ? state.value?.exportResult('save') : workspace.saveResult(),
    onClearResult: () => enabled.value ? state.value?.clearResult() : workspace.onClearResult(),
  }
}

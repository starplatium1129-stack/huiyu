import { computed, watch } from 'vue'
import type { usePromptWorkspace } from './usePromptWorkspace'
import { useNativeDrawing } from './useNativeDrawing'
import { useCompareSnapshots } from '@/composables/useCompareSnapshots'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import type { ResultSnapshot } from './promptResultSnapshot'

/** One canvas and action bar; each generation session keeps its own parameters and results. */
export function useDrawingCanvas(workspace: ReturnType<typeof usePromptWorkspace>) {
  const native = useNativeDrawing(workspace), enabled = computed(() => !!native.mode.value)
  const state = native.session
  const mossCompare = useCompareSnapshots<ResultSnapshot>({ build: url => {
    const task = state.value?.result.value
    if (!task || task.kind !== 'moss') throw new Error('MOSS 结果尚未就绪')
    const input = { ...task.input, ...task.metadata }
    return { url, seed: typeof input.seed === 'number' && input.seed >= 0 ? input.seed : null,
      styleLoraId: null, size: `${input.width}x${input.height}`,
      sampler: typeof input.sampler === 'string' ? input.sampler : '—',
      cfg: Number(input.cfg), steps: Number(input.steps),
      hires: input.mossUpscaleScale === 1.5 || input.mossUpscaleScale === 2 ? `Remacri ×${input.mossUpscaleScale}` : '关',
      at: new Date(task.createdAt).toLocaleTimeString() }
  } })
  let comparedTask = ''
  watch(() => state.value?.resultUrl.value, url => {
    const task = state.value?.result.value
    if (native.mode.value !== 'moss' || !url || !task || task.taskId === comparedTask) return
    comparedTask = task.taskId
    mossCompare.rotate(url)
  }, { flush: 'sync' })
  watch(runtimeResourceIdentity, () => { comparedTask = ''; mossCompare.clear() }, { flush: 'sync' })
  watch(native.mode, () => mossCompare.close(), { flush: 'sync' })
  const prevResult = computed(() => enabled.value ? native.mode.value === 'moss' ? mossCompare.prevResult.value : null : workspace.prevResult.value)
  const lastResult = computed(() => enabled.value ? native.mode.value === 'moss' ? mossCompare.lastResult.value : null : workspace.dialogBindings.lastResult.value)
  const compareOpen = computed({ get: () => enabled.value ? native.mode.value === 'moss' && mossCompare.compareOpen.value : workspace.compareOpen.value,
    set: value => { if (native.mode.value === 'moss') mossCompare.compareOpen.value = value; else if (!enabled.value) workspace.compareOpen.value = value } })
  const closeCompare = () => { mossCompare.close(); workspace.dialogBindings.closeCompare() }
  return { ...workspace, native,
    prevResult, lastResult, compareOpen, closeCompare,
    dialogBindings: { ...workspace.dialogBindings, prevResult, lastResult, compareOpen, closeCompare },
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

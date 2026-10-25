import { computed, effectScope, onActivated, onDeactivated, onScopeDispose, ref, shallowRef, watch, type EffectScope } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDrawingNavigation } from './useDrawingNavigation'
import type { usePromptWorkspace } from './usePromptWorkspace'
import type { GenerationPresentation } from './useGenerationPresentation'
import { useQwenStudio } from '@/composables/generation/useQwenStudio'
import { nativeDrawingPrompt } from '@/utils/nativeDrawingPrompt'

export function useNativeDrawing(workspace: ReturnType<typeof usePromptWorkspace>) {
  const navigation = useDrawingNavigation(), route = useRoute(), router = useRouter(), active = ref(true)
  const mode = navigation.mode, session = shallowRef<ReturnType<typeof useQwenStudio> | null>(null)
  let scope: EffectScope | undefined
  const recipe = computed(() => {
    try { return { ...nativeDrawingPrompt(workspace.healthBindings.structuredPlan.value,
      workspace.pb.visualDescription, session.value?.form.negative || '', mode.value || 'qwen'), error: '' } }
    catch (cause) { return { raw: workspace.pb.visualDescription, prompt: '', negative: '', error: cause instanceof Error ? cause.message : '提示词尚未准备好' } }
  })
  const busy = computed(() => !!session.value && (session.value.busy.value || session.value.unresolved.value || session.value.importing.value || session.value.cancelling.value))
  const locked = computed(() => !session.value || session.value.locked.value)
  const blocked = computed(() => {
    const state = session.value
    if (!state?.ready.value) return state?.error.value || '正在恢复绘图参数…'
    if (!workspace.pb.dataReady) return '正在读取创作素材…'
    if (recipe.value.error) return recipe.value.error
    if (state.saving.value) return '正在保存作品…'
    if (state.observing.value && !state.unresolved.value) return '正在读取原任务与结果…'
    if (state.draftRecoveryNeeded.value) return '请先处理未恢复的模型草稿'
    if (state.source.value || state.restoredInputMissing.value) return '原任务含图片输入，请在 Qwen 编辑窗口继续'
    if (!recipe.value.raw.trim()) return '选择场景，或填写画面描述'
    if (state.issue.value.startsWith('填写画面描述')) return ''
    return state.issue.value
  })
  const size = computed({ get: () => `${session.value?.form.width || 1024}x${session.value?.form.height || 1024}`,
    set: value => { if (!session.value || locked.value) return; const [width, height] = value.split('x').map(Number); session.value.form.width = width; session.value.form.height = height } })
  const sizes = computed(() => [...new Set([size.value, ...(mode.value === 'moss' ? ['768x1280', '1024x1024', '1280x768', '1152x1536', '1536x1152'] : ['1024x1024', '1024x1536', '1536x1024', '832x1216', '1216x832'])])])
  const presentation = computed<GenerationPresentation>(() => {
    const state = session.value, task = state?.task.value
    const phase = state?.cancelling.value || task?.status === 'cancelling' ? 'cancelling'
      : state?.busy.value ? 'submitting' : state?.unresolved.value ? 'running' : task?.status === 'succeeded' ? 'succeeded'
        : task?.status === 'cancelled' ? 'cancelled' : state?.error.value ? 'failed' : 'idle'
    return { phase, message: state?.taskText.value || state?.notice.value || '', progress: state?.progress.value === null || state?.progress.value === undefined ? null : state.progress.value / 100,
      needsReview: !!state?.unresolved.value && !state.observing.value && !state.busy.value,
      completed: phase === 'succeeded' && !!state?.resultUrl.value, canRetryCancellation: !!state?.error.value, review: () => { void state?.observe() } }
  })
  function dispose() { scope?.stop(); scope = undefined; session.value = null }
  async function initialize() {
    dispose()
    if (!active.value || !mode.value) return
    scope = effectScope(); const state = scope.run(() => useQwenStudio(mode.value!))!
    session.value = state
    const entry = { preparedModel: route.query.preparedModel, job: route.query.editor === 'qwen' ? undefined : route.query.job }
    await state.initialize(typeof entry.preparedModel === 'string' ? entry.preparedModel : undefined,
      typeof entry.job === 'string' ? entry.job : undefined)
    if (session.value !== state || !state.ready.value || state.error.value || state.draftRecoveryNeeded.value || state.restoredInputMissing.value || !(entry.job || entry.preparedModel)) return
    if (!await state.persistDraft() || session.value !== state || route.query.editor === 'qwen') return
    const query = { ...route.query }
    if (query.job === entry.job) delete query.job
    if (query.preparedModel === entry.preparedModel) delete query.preparedModel
    await router.replace({ query })
  }
  watch(() => [mode.value, route.query.editor === 'qwen' ? undefined : route.query.job, route.query.preparedModel], (next, previous) => {
    if (!previous || next[0] !== previous[0] || next.slice(1).some((value, index) => value && value !== previous[index + 1])) void initialize()
  }, { immediate: true })
  watch(workspace.genBarSize, value => {
    const state = session.value
    if (!state || locked.value) return
    const dimensions = value.split('x').map(Number).map(value => Math.max(512, Math.min(state.maxSize, Math.round(value / state.alignment) * state.alignment)))
    size.value = dimensions.join('x')
  })
  async function generate() {
    const state = session.value
    if (!state || locked.value || blocked.value) return
    state.form.prompt = recipe.value.raw
    const pb = workspace.pb, subject = pb.subject
    await state.run({ negative: state.turbo.value ? '' : recipe.value.negative, context: {
      character: pb.char, characterId: pb.subject.kind === 'popular' ? pb.subject.characterId : pb.char,
      ...(pb.subject.kind === 'popular' ? { outfitId: pb.subject.outfitId, blueprintId: pb.subject.blueprintId } : {}),
      sceneTitle: (subject.kind === 'popular' ? pb.sceneBlueprints.find(scene => scene.id === subject.blueprintId)?.title : pb.activeScene?.title) || '', story: pb.story, visualDescription: pb.visualDescription,
    } })
  }
  async function saveBeforeSwitch() {
    const state = session.value
    if (!state?.ready.value) return true
    if (state.draftRecoveryNeeded.value) { state.error.value = '请先恢复草稿，或保留旧草稿并保存当前参数，再切换引擎'; return false }
    return state.persistDraft()
  }
  onDeactivated(() => { active.value = false; dispose() })
  onActivated(() => { if (!active.value) { active.value = true; void initialize() } })
  onScopeDispose(dispose)
  return { mode, session, recipe, busy, locked, blocked, size, setSize: (value: string) => { size.value = value }, sizes, presentation, generate, initialize, saveBeforeSwitch }
}
export type NativeDrawing = ReturnType<typeof useNativeDrawing>

import { computed, effectScope, nextTick, onActivated, onDeactivated, onScopeDispose, ref, shallowRef, watch, type EffectScope } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDrawingNavigation } from './useDrawingNavigation'
import type { usePromptWorkspace } from './usePromptWorkspace'
import type { GenerationPresentation } from './useGenerationPresentation'
import { useQwenStudio } from '@/composables/generation/useQwenStudio'
import { nativeDrawingPrompt } from '@/utils/nativeDrawingPrompt'
import { renderMossDrawingPrompt } from '@/utils/mossPrompt'
import { compileMossLayout, isMossLayoutInput } from '@/utils/mossLayout'
import { isCustomCastOutfit } from '@/utils/promptCast'
import { captureResultContext } from '@/utils/resultContext'
import { mossModels } from '@/config/directImageModels'
import { fuseMossCastPrompt } from '@/api/fuseCastLayout'

function layoutHash(input: string) {
  let hash = 2166136261
  for (let index = 0; index < input.length; index++) hash = Math.imul(hash ^ input.charCodeAt(index), 16777619)
  return (hash >>> 0).toString(16)
}

export function useNativeDrawing(workspace: ReturnType<typeof usePromptWorkspace>) {
  const navigation = useDrawingNavigation(), route = useRoute(), router = useRouter(), active = ref(true)
  const mode = navigation.mode, session = shallowRef<ReturnType<typeof useQwenStudio> | null>(null)
  let scope: EffectScope | undefined
  const preparingSubmission = shallowRef<AbortController | null>(null)
  const coordinatingCast = ref(false)
  const pb = workspace.pb
  const castLayoutContext = computed(() => Boolean(pb.cast.length > 1 || pb.castLead?.source === 'custom'
    || isCustomCastOutfit(pb.castLead?.outfitId ?? '')))
  const legacyLayoutContext = computed(() => {
    if (!castLayoutContext.value && !pb.referenceInput) return ''
    return layoutHash(JSON.stringify([
      pb.cast.map(({ source, characterId, outfitId, outfitExplicit, action, outfitPrompt, name, appearance, gender }) =>
        [source, characterId, outfitId, outfitExplicit, action, ...(outfitPrompt || source === 'custom' ? [outfitPrompt, name, appearance, gender] : [])]),
      pb.effectiveCastFormation, pb.referenceInput, ...(pb.castInteraction.trim() && pb.cast.length > 1 ? [pb.castInteraction.trim()] : []),
    ]))
  })
  const layoutContext = computed(() => `v2-${layoutHash(JSON.stringify([
    pb.cast.map(({ source, characterId }) => [source, characterId]),
    pb.effectiveCastFormation, session.value?.form.width, session.value?.form.height,
  ]))}`)
  const staleMossLayout = computed(() => {
    const form = session.value?.form
    if (!form?.mossLayout) return false
    const context = form.mossLayoutContext
    if (context === undefined) return castLayoutContext.value
    return context.startsWith('v2-') ? context !== layoutContext.value : context !== legacyLayoutContext.value
  })
  const mossLayout = computed(() => staleMossLayout.value ? '' : session.value?.form.mossLayout || '')
  const usingMossTaskPrompt = computed(() => session.value?.form.mossUseTaskPrompt === true)
  function mossCanvas() {
    const state = session.value
    const { width, height } = state?.form ?? { width: 768, height: 1280 }
    const maxSize = state?.maxSize ?? 1536, alignment = state?.alignment ?? 16
    if (![width, height].every(n => Number.isInteger(n) && n >= 512 && n <= maxSize && n % alignment === 0)) {
      throw new Error(`MOSS 画幅宽高需为 512–${maxSize} 内的 ${alignment} 倍数`)
    }
    return { width, height }
  }
  const mossDescription = computed(() => {
    const plan = workspace.mossPlan.value
    const lead = pb.leadCast, primary = pb.castLead
    const projected = plan?.mossLayout?.castLayout || !pb.isUnbound && pb.referenceInput?.subjectMode === 'free'
      || Boolean(lead?.action && primary && lead.source === primary.source && lead.characterId === primary.characterId)
    return projected && plan ? plan.visualDescription : pb.visualDescription
  })
  const recipe = computed(() => {
    const form = session.value?.form
    const description = workspace.pb.visualDescription, negative = form?.negative ?? ''
    try {
      if (mode.value !== 'moss') return { ...nativeDrawingPrompt(workspace.healthBindings.structuredPlan.value, description, negative), error: '' }
      const size = mossCanvas()
      if (usingMossTaskPrompt.value) {
        const raw = form?.prompt ?? ''
        const prompt = isMossLayoutInput(raw) ? compileMossLayout(raw, size).prompt : raw
        return { raw, prompt, negative, error: '' }
      }
      return { ...renderMossDrawingPrompt(workspace.mossPlan.value, mossLayout.value || mossDescription.value, negative, size), error: '' }
    }
    catch (cause) { return { raw: workspace.pb.visualDescription, prompt: '', negative: '', error: cause instanceof Error ? cause.message : '提示词尚未准备好' } }
  })
  const busy = computed(() => !!preparingSubmission.value || !!session.value && (session.value.busy.value || session.value.unresolved.value || session.value.importing.value || session.value.cancelling.value))
  const locked = computed(() => !session.value || session.value.locked.value)
  function mossLayoutDraft(automatic = false) {
    const description = usingMossTaskPrompt.value ? session.value?.form.prompt ?? '' : mossDescription.value
    if (!automatic && (mossLayout.value || isMossLayoutInput(description))) return mossLayout.value || description
    const plan = usingMossTaskPrompt.value ? null : workspace.mossPlan.value
    return renderMossDrawingPrompt(plan, description, '', mossCanvas(), { forceLayout: true }).raw
  }
  function applyMossLayout(value: string) {
    const state = session.value
    if (mode.value !== 'moss' || !state || locked.value) throw new Error('当前无法修改布局')
    const source = value.trim()
    if (source) {
      const { prompt } = compileMossLayout(source, mossCanvas())
      if (source.length > 12000 || prompt.length > 12000) throw new Error('布局提示词超过 12000 字符，请精简描述')
    }
    state.form.mossLayout = source
    state.form.mossLayoutContext = source ? layoutContext.value : undefined
    state.form.mossUseTaskPrompt = false
  }
  const blocked = computed(() => {
    const state = session.value
    if (!state?.ready.value) return state?.error.value || '正在恢复绘图参数…'
    if (!pb.dataReady || mode.value === 'moss' && !workspace.draftReady.value) return '正在读取创作素材…'
    if (mode.value === 'moss' && staleMossLayout.value) return '手工布局需要重排或清除'
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
  const sizes = computed(() => {
    const presets = mode.value === 'moss'
      ? ['768x1280', '1280x768', '1280x1280', '960x1536', '1536x960', '1536x1536']
      : ['1024x1024', '1024x1536', '1536x1024', '832x1216', '1216x832']
    return presets.includes(size.value) ? presets : [...presets, size.value]
  })
  const presentation = computed<GenerationPresentation>(() => {
    const state = session.value, task = state?.task.value
    const phase = state?.cancelling.value || task?.status === 'cancelling' ? 'cancelling'
      : preparingSubmission.value || state?.busy.value ? 'submitting' : state?.unresolved.value ? 'running' : task?.status === 'succeeded' ? 'succeeded'
        : task?.status === 'cancelled' ? 'cancelled' : state?.error.value ? 'failed' : 'idle'
    return { phase, message: coordinatingCast.value ? '正在协调角色动作与构图…' : state?.taskText.value || state?.notice.value || '', progress: state?.progress.value === null || state?.progress.value === undefined ? null : state.progress.value / 100,
      needsReview: !!state?.unresolved.value && !state.observing.value && !state.busy.value,
      completed: phase === 'succeeded' && !!state?.resultUrl.value, canRetryCancellation: !!state?.error.value, review: () => { void state?.observe() } }
  })
  function cancel() {
    if (preparingSubmission.value) preparingSubmission.value.abort()
    else return session.value?.cancel()
  }
  function dispose() {
    preparingSubmission.value?.abort()
    preparingSubmission.value = null
    coordinatingCast.value = false
    scope?.stop()
    scope = undefined
    session.value = null
  }
  async function initialize() {
    dispose()
    if (!active.value || !mode.value) return
    scope = effectScope(); const state = scope.run(() => useQwenStudio(mode.value!))!
    session.value = state
    const entry = { preparedModel: route.query.preparedModel, job: route.query.editor === 'qwen' ? undefined : route.query.job }
    await state.initialize(typeof entry.preparedModel === 'string' ? entry.preparedModel : undefined,
      typeof entry.job === 'string' ? entry.job : undefined)
    if (session.value !== state || !state.ready.value || state.error.value || state.draftRecoveryNeeded.value || state.restoredInputMissing.value || !(entry.job || entry.preparedModel)) return
    if (route.query.firstDraw === '1' && entry.preparedModel
      && (!state.selected.value?.available || state.selected.value.id !== entry.preparedModel)) return
    if (!await state.persistDraft() || session.value !== state || route.query.editor === 'qwen') return
    const query = { ...route.query }
    if (query.job === entry.job) delete query.job
    if (query.preparedModel === entry.preparedModel) delete query.preparedModel
    await router.replace({ query })
  }
  watch(() => [mode.value, route.query.editor === 'qwen' ? undefined : route.query.job, route.query.preparedModel], (next, previous) => {
    if (!previous || next[0] !== previous[0] || next.slice(1).some((value, index) => value && value !== previous[index + 1])) void initialize()
  }, { immediate: true })
  watch(legacyLayoutContext, () => {
    const state = session.value
    if (!workspace.draftReady.value || mode.value !== 'moss' || !state?.ready.value) return
    state.form.mossUseTaskPrompt = false
  })
  watch([() => session.value?.ready.value, workspace.draftReady], ([ready, draftReady]) => {
    const form = session.value?.form
    if (ready && draftReady && form?.mossLayout && !staleMossLayout.value && !form.mossLayoutContext?.startsWith('v2-')) {
      form.mossLayoutContext = layoutContext.value
    }
  }, { flush: 'post' })
  watch([workspace.nativeHistoryRecipe, mode, locked, workspace.draftReady], ([record, activeMode, isLocked, draftReady]) => {
    const state = session.value
    if (!record || activeMode !== 'moss' || !state || isLocked || !draftReady) return
    workspace.nativeHistoryRecipe.value = null
    const form = state.form
    const modelId = record.model || record.checkpoint
    if (mossModels.some(model => model.value === modelId) && state.models.value.some(model => model.id === modelId && model.available)) {
      form.modelId = String(modelId)
    }
    const [width, height] = (record.size || '').replace(/\s/g, '').split(/[x×]/).map(Number)
    if ([width, height].every(value => Number.isInteger(value) && value >= 512 && value <= state.maxSize && value % state.alignment === 0)) {
      form.width = width
      form.height = height
    }
    if (record.mossSampler === 'euler' || record.mossSampler === 'er-sde') state.selectMossSampler(record.mossSampler)
    if (typeof record.steps === 'number' && Number.isInteger(record.steps) && record.steps >= 1 && record.steps <= 100) form.steps = record.steps
    if (typeof record.cfg === 'number' && Number.isFinite(record.cfg) && record.cfg >= 0 && record.cfg <= 20) form.cfg = record.cfg
    if (typeof record.seed === 'number' && Number.isInteger(record.seed) && record.seed >= 0 && record.seed <= 2147483647) {
      form.seed = record.seed
      state.randomSeed.value = false
    } else state.randomSeed.value = true
    const negative = record.negativeCustom ?? record.negative
    if (typeof negative === 'string' && negative.length <= 8000) form.negative = negative
    const layout = record.mossLayout
    form.mossLayout = typeof layout === 'string' && layout.length <= 12000 && isMossLayoutInput(layout) ? layout : ''
    form.mossLayoutContext = form.mossLayout ? layoutContext.value : undefined
    form.mossUseTaskPrompt = record.subject === undefined && typeof record.prompt === 'string' && record.prompt.length <= 12000
    if (form.mossUseTaskPrompt && typeof record.prompt === 'string') form.prompt = record.prompt
  }, { flush: 'post' })
  watch(workspace.genBarSize, value => {
    const state = session.value
    if (!state || locked.value) return
    const dimensions = value.split('x').map(Number).map(value => Math.max(512, Math.min(state.maxSize, Math.round(value / state.alignment) * state.alignment)))
    size.value = dimensions.join('x')
  })
  async function generate(assist = false) {
    const state = session.value
    if (!state || locked.value || blocked.value || preparingSubmission.value) return
    let finalMossPrompt = recipe.value.prompt
    if (mode.value === 'moss') {
      const preparation = new AbortController()
      preparingSubmission.value = preparation
      const draftKey = () => JSON.stringify({ ...pb.snapshotDraft(), updatedAt: undefined })
      const before = draftKey()
      try {
        await nextTick()
        await pb.persistDraft()
        if (preparation.signal.aborted || session.value !== state || locked.value || blocked.value || draftKey() !== before) return
        if (assist && !usingMossTaskPrompt.value && !mossLayout.value && pb.cast.length >= 2 && isMossLayoutInput(finalMossPrompt)) {
          coordinatingCast.value = true
          const fused = await fuseMossCastPrompt({
            draftPrompt: finalMossPrompt,
            plan: workspace.mossPlan.value,
            cast: pb.cast,
            interaction: pb.castInteraction,
            userDescription: pb.visualDescription,
            reference: pb.referenceInput,
            signal: preparation.signal,
          })
          finalMossPrompt = fused.prompt
          if (fused.warning && !preparation.signal.aborted && session.value === state && draftKey() === before) {
            pb.flash(fused.warning, 4200, 'warning')
          }
        }
      } catch {
        // The draft store reports why its durable write could not be confirmed.
        return
      } finally {
        if (preparingSubmission.value === preparation) {
          preparingSubmission.value = null
          coordinatingCast.value = false
        }
      }
      if (preparation.signal.aborted || session.value !== state || locked.value || blocked.value || draftKey() !== before) return
    }
    const subject = pb.subject
    const director = mode.value === 'moss' ? captureResultContext(pb) : null
    state.form.prompt = mode.value === 'moss' ? finalMossPrompt : recipe.value.raw
    await state.run({ negative: state.turbo.value ? '' : recipe.value.negative, context: {
      ...(director ? { subject: subject.kind, sceneId: pb.sceneId,
        history: { ...director.history, negativeCustom: state.form.negative, mossLayout: mossLayout.value || undefined } } : {}),
      character: pb.char, characterId: pb.castLead?.characterId ?? pb.char,
      ...(pb.subject.kind === 'popular' ? { outfitId: pb.subject.outfitId, blueprintId: pb.subject.blueprintId } : {}),
      sceneTitle: (subject.kind === 'popular' ? pb.sceneBlueprints.find(scene => scene.id === subject.blueprintId)?.title : pb.activeScene?.title) || '', story: pb.story, visualDescription: pb.visualDescription,
    } })
  }
  async function saveBeforeSwitch() {
    const state = session.value
    if (!state?.ready.value) return true
    if (state.draftRecoveryNeeded.value) throw new Error('请先恢复草稿，或保留旧草稿并保存当前参数，再切换引擎')
    if (state.restoredInputMissing.value) throw new Error('原图尚未恢复，请在「继续编辑原图」中恢复输入，或转为文生图后再切换引擎')
    if (!await state.persistDraft()) throw new Error(state.draftFailed.value ? state.draftStatus.value : '当前参数尚未保存，请稍后重试切换引擎')
    return true
  }
  onDeactivated(() => { active.value = false; dispose() })
  onActivated(() => { if (!active.value) { active.value = true; void initialize() } })
  onScopeDispose(dispose)
  return { mode, session, recipe, mossLayout, staleMossLayout, usingMossTaskPrompt, mossLayoutDraft, applyMossLayout, busy, locked, blocked, size, setSize: (value: string) => { size.value = value }, sizes, presentation, generate, cancel, initialize, saveBeforeSwitch }
}
export type NativeDrawing = ReturnType<typeof useNativeDrawing>

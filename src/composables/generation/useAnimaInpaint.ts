import { computed, getCurrentScope, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import type { DrawEngine } from '@/storage/settingsRepository'
import type { useAnimaSession } from '@/composables/generation/useAnimaSession'
import type { InpaintSubmitPayload } from '@/components/AnimaInpaintModal.vue'
import type { InpaintSubmissionSnapshot } from './animaInpaintSubmit'

type PromptBuilderStore = ReturnType<typeof usePromptBuilderStore>
type AnimaSession = ReturnType<typeof useAnimaSession>

export interface AnimaInpaintDeps {
  pb: PromptBuilderStore
  drawEngine: Ref<DrawEngine>
  animaState: AnimaSession['state']
  generateAnima: AnimaSession['generate']
  captureAnimaSubmission: AnimaSession['captureSubmission']
  preparing: Ref<boolean>
  /** 当前是否热门角色（popular）模式；热门角色无 LoRA，换装必须走无 LoRA 底模。 */
  isPopular: ComputedRef<boolean>
  /** 热门角色的 Danbooru 身份标签（exactTokens + identityTokens），换装时拼入提示词头部，
   *  让模型知道「衣服穿在谁身上」——此前热门角色换装只传衣服词，新衣光影/气质与原图脱节。 */
  popularIdentityTokens: ComputedRef<string[]>
}

/**
 * 绘图页「Anima 智能局部换装」编排（2026-08-22 自 PromptBuilderView 下沉）。
 *
 * 原图/遮罩 FileReader → base64 → /api/anima/images 落盘，按目标尺寸与
 * 角色 LoRA 形态解析无 LoRA 绑定（resolveInpaintRequestBinding），组装
 * 换装提示词后走 generateAnima 覆盖式提交。同时持有弹窗开关与
 * 「换装前后对比」的原图 URL / 对比开关状态。
 */
export function useAnimaInpaint(deps: AnimaInpaintDeps) {
  const { pb, drawEngine, isPopular, preparing } = deps

  const inpaintOpen = ref(false)
  const inpaintOriginalUrl = ref<string | null>(null)
  const inpaintCompareActive = ref(false)
  let controller: AbortController | null = null
  let disposed = false, submittingInpaint = false
  function clearInpaintOriginal() {
    if (inpaintOriginalUrl.value) URL.revokeObjectURL(inpaintOriginalUrl.value)
    inpaintOriginalUrl.value = null
    inpaintCompareActive.value = false
  }
  function cancelInpaintPreparation(silent = false): boolean {
    if (!controller) return false
    controller.abort(); controller = null; preparing.value = false
    if (!silent) pb.flash('已取消换装准备')
    return true
  }
  watch(inpaintOpen, open => { if (!open) cancelInpaintPreparation() }, { flush: 'sync' })
  watch(drawEngine, () => { cancelInpaintPreparation(true); clearInpaintOriginal() }, { flush: 'sync' })
  watch(() => deps.animaState.value.phase, phase => {
    if (['submitting', 'running', 'cancelling'].includes(phase)) cancelInpaintPreparation(true)
    if (phase === 'submitting' && !submittingInpaint) clearInpaintOriginal()
  }, { flush: 'sync' })
  if (getCurrentScope()) onScopeDispose(() => { disposed = true; cancelInpaintPreparation(true); clearInpaintOriginal() })

  const inpaintCharacter = computed<'nene' | 'natsume' | null>(() => {
    // 热门角色（popular）模式没有 LoRA 绑定，必须返回 null 走无 LoRA 底模；
    // 否则 pb.char 仍是默认 'nene'，会把热门角色图误绑 nene LoRA 导致「换衣变脸」。
    if (isPopular.value) return null
    return pb.char === 'nene' || pb.char === 'natsume' ? pb.char : null
  })

  async function handleInpaintSubmit(payload: InpaintSubmitPayload) {
    if (disposed || controller || ['submitting', 'running', 'cancelling'].includes(deps.animaState.value.phase)) return
    if (drawEngine.value !== 'anima') {
      pb.flash('局部换装目前专属于 Anima 引擎')
      return
    }
    const submission = deps.captureAnimaSubmission()
    if (!submission || submission.family !== 'anima') { pb.flash('当前 Anima 配方尚未就绪，请重新确认后换装'); return }
    // Capture before even the lazy import: no later upload or form edit owns this operation.
    const snapshot: InpaintSubmissionSnapshot = {
      payload: { ...payload },
      effectiveChar: payload.characterOverride !== undefined ? payload.characterOverride : inpaintCharacter.value,
      isPopular: isPopular.value, identityTokens: [...deps.popularIdentityTokens.value],
      model: { models: JSON.parse(JSON.stringify(deps.animaState.value.models)), modelId: deps.animaState.value.modelId,
        width: deps.animaState.value.width, height: deps.animaState.value.height, loraStrength: deps.animaState.value.loraStrength },
    }
    const active = new AbortController(); controller = active; preparing.value = true
    const current = () => !disposed && controller === active && !active.signal.aborted && drawEngine.value === 'anima'
    try {
      const { submitAnimaInpaint } = await import('./animaInpaintSubmit')
      if (!current()) return
      await submitAnimaInpaint(snapshot, { signal: active.signal, current, flash: message => pb.flash(message),
        submission, generate: deps.generateAnima, begin: originalUrl => {
        clearInpaintOriginal(); inpaintOriginalUrl.value = originalUrl
        controller = null; preparing.value = false; inpaintOpen.value = false
        submittingInpaint = true
      }, started: () => { submittingInpaint = false } })
    } catch (error: unknown) {
      if (!current()) return
      const message = error instanceof Error ? error.message : String(error)
      pb.flash(`换装失败：${message}`)
    } finally {
      if (controller === active) { controller = null; preparing.value = false }
    }
  }

  return {
    inpaintOpen,
    inpaintOriginalUrl,
    inpaintCompareActive,
    inpaintCharacter,
    handleInpaintSubmit,
    cancelInpaintPreparation,
    clearInpaintOriginal,
  }
}

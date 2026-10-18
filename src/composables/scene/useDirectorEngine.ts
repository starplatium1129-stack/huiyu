import { computed, type Ref } from 'vue'
import {
  closestSupportedSize,
  type AnimaRequest,
} from '@/composables/generation/useAnimaSession'
import type { useAnimaSession } from '@/composables/generation/useAnimaSession'
import type { useLegacySdTasks } from '@/composables/generation/useLegacySdTasks'
import type { usePromptAssembly } from '@/composables/prompt/usePromptAssembly'
import type { useUnifiedPromptAssembly } from '@/composables/useUnifiedPromptAssembly'
import type { AnimaPhase, AnimaResult } from '@/types/anima'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { resolveDrawCapabilities } from '@/utils/drawCapabilities'
import { endfieldAnimaBinding } from '@/utils/loraCatalog'
import { buildAnimaRequest as buildBoundAnimaRequest } from '@/composables/generation/buildAnimaRequest'
import {
  DRAW_ENGINE_SETTING,
  settingsRepository,
  type DrawEngine,
} from '@/storage/settingsRepository'

type PromptBuilderStore = ReturnType<typeof usePromptBuilderStore>
type SDGenerate = ReturnType<typeof useLegacySdTasks>
type AnimaSession = ReturnType<typeof useAnimaSession>
type StudioAssembly = ReturnType<typeof usePromptAssembly>
type UnifiedAssembly = ReturnType<typeof useUnifiedPromptAssembly>

export interface UseDirectorEngineInput {
  pb: PromptBuilderStore
  sd: SDGenerate
  /** 出图尺寸（视图/参数面板共享的可写 ref，由宿主持有） */
  sdSize: Ref<string>
  /** 激活引擎：持久化 UI 设置，ref 由宿主持有，切换动作在本模块内收口 */
  drawEngine: Ref<DrawEngine>
  animaState: AnimaSession['state']
  patchAnimaState: AnimaSession['patchState']
  refreshAnimaBackend: AnimaSession['refreshBackend']
  syncAnimaCharacter: AnimaSession['syncCharacter']
  applyModel: AnimaSession['applyModel']
  cancelAnimaJob: AnimaSession['cancel']
  clearAnimaResult: AnimaSession['clearResult']
  /** 组装层输出：宿主在组装 composables 创建后注入（引擎请求装配的懒依赖） */
  livePrompt: UnifiedAssembly['positivePrompt']
  effectiveNegative: UnifiedAssembly['negativePrompt']
  modelProfile: StudioAssembly['modelProfile']
  modelProfileView: UnifiedAssembly['modelProfile']
  popularProfile: UnifiedAssembly['popular']['profile']
  flash: (message: string) => void
}

/**
 * 导演台跨引擎协调层（2026-08-28 编排下沉，照 useAnimaInpaint 的依赖注入样板）：
 * 引擎切换守卫、能力表、在线/进度/错误聚合展示、Anima 请求装配与推荐尺寸收敛。
 * 只做协调与派生，不持有队列（usePromptSdQueue）、历史（usePromptHistoryApply）
 * 与深链（usePromptDeepLink）生命周期。
 */
export function useDirectorEngine(input: UseDirectorEngineInput) {
  const {
    pb,
    sd,
    sdSize,
    drawEngine,
    animaState,
    patchAnimaState,
    refreshAnimaBackend,
    syncAnimaCharacter,
    applyModel,
    cancelAnimaJob,
    clearAnimaResult,
    livePrompt,
    effectiveNegative,
    modelProfile,
    modelProfileView,
    popularProfile,
    flash,
  } = input

  /** 当前引擎/底模能力表：UI 与请求组装统一从这里判断，不再散落写 engine === '...'。 */
  const currentCapabilities = computed(() => {
    if (drawEngine.value === 'sd') return resolveDrawCapabilities('sd', modelProfileView.value)
    const selected = animaState.value.models.find(model => model.id === animaState.value.modelId)
    return resolveDrawCapabilities(
      drawEngine.value === 'krea2' ? 'krea2' : 'anima',
      modelProfileView.value,
      selected?.capabilities ?? null,
    )
  })

  /** 自由画面或热门角色在支持 noLora 的底模上不加载角色 LoRA。 */
  const animaNoLoraMode = computed(() => {
    if (!pb.isPopular && !pb.isUnbound) return false
    if (!currentCapabilities.value.noLora) return false
    const selected = animaState.value.models.find(model => model.id === animaState.value.modelId)
    return selected?.capabilities?.noLora === true && !(pb.subject.kind === 'popular'
      && endfieldAnimaBinding(pb.subject.characterId, animaState.value.family, animaState.value.modelId))
  })

  /** 引擎按钮禁用态由能力表驱动（双人支持等）。 */
  function supportsDualCharacter(engine: DrawEngine): boolean {
    return resolveDrawCapabilities(engine).dualCharacter
  }

  function setDrawEngine(v: DrawEngine, options: { silent?: boolean; restoreExistingResult?: boolean } = {}) {
    if (options.restoreExistingResult && v !== 'sd') { drawEngine.value = v; return }
    if (v === 'sd') {
      // Restore an already loaded result without selecting SD for new work.
      if (options.restoreExistingResult && sd.resultUrl.value) { drawEngine.value = 'sd'; return }
      flash('SD 新生成已退役，旧作品与配方仍可查看；请选择 Anima 或 Krea 2')
      return
    }
    if (!supportsDualCharacter(v) && pb.char === 'triad' && !pb.isPopular) {
      flash('当前绘图路径暂不支持旧双角色配置，请重新选择单个角色')
      return
    }
    if (drawEngine.value === v) {
      return
    }
    try {
      settingsRepository.set(DRAW_ENGINE_SETTING, v)
    } catch {
      flash('绘图引擎设置保存失败')
      return
    }
    drawEngine.value = v
    patchAnimaState({ styleLoraId: '' })
    syncAnimaCharacter(pb.char)
    void refreshAnimaBackend()
    if (!options.silent) flash(v === 'anima'
      ? (pb.isUnbound ? '已切换到 Anima（无角色 LoRA）' : pb.isPopular ? '已切换到 Anima（按角色配置加载 LoRA）' : '已切换到 Anima 引擎（ComfyUI + 角色 LoRA）')
      : '已切换到 Krea 2（自然语言、无角色 LoRA，身份不保证）')
  }

  /** 推荐尺寸必须收敛到当前底模白名单（服务端 400 INVALID_PARAMETER 兜底）。 */
  function applyRecommendedSize(size: string) {
    const normalized = size.replace('×', 'x')
    sdSize.value = normalized
    const activeModel = animaState.value.models.find(model => model.id === animaState.value.modelId)
    const supported = closestSupportedSize(activeModel, normalized)
    const [width, height] = supported.split('x').map(Number)
    if (Number.isInteger(width) && Number.isInteger(height)) patchAnimaState({ width, height })
  }

  // ── 引擎统一结果：Anima 结果带不可变 job metadata，历史不再读取当前面板状态。
  // 会话（useAnimaSession）已写入 result/job/phase；这里只做跨引擎互斥协调。
  function onAnimaResult(_result: AnimaResult) {
    sd.clearResult()
  }
  function clearDisplayedResult() {
    if (drawEngine.value === 'sd') sd.clearResult()
    else clearAnimaResult()
  }
  const displayResultUrl = computed(() => drawEngine.value !== 'sd' ? (animaState.value.result?.url ?? '') : sd.resultUrl.value)
  const displayResultSeed = computed(() => drawEngine.value !== 'sd' ? animaState.value.result?.metadata.seed ?? null : sd.resultSeed.value)

  const drawEngineLabel = computed(() => drawEngine.value === 'sd' ? 'SD' : drawEngine.value === 'anima' ? 'Anima' : 'Krea 2')
  const generationStatusText = computed(() => drawEngine.value === 'sd' ? sd.statusText.value
    : ['submitting', 'running'].includes(animaState.value.phase) ? animaState.value.progressText || animaState.value.statusText : animaState.value.statusText)
  const engineOnline = computed(() => {
    const ready = animaState.value.online || animaState.value.managedStartAvailable === true
    if (drawEngine.value === 'anima') {
      if (pb.isPopular || pb.isUnbound) return ready && animaState.value.models.some(m => m.id === animaState.value.modelId && m.available !== false && (!pb.isUnbound || m.capabilities?.noLora === true))
      return (currentCapabilities.value.dualCharacter || pb.char !== 'triad') && Boolean(animaState.value.loraId) && ready
    }
    if (drawEngine.value === 'krea2') return ready
    return sd.online.value
  })
  const generationBusy = computed(() => sd.generating.value || (['submitting', 'running', 'cancelling'] as string[]).includes(animaState.value.phase))
  // SD 侧 progress 可空（WebUI 路径 / 尚未收到步骤事件时后端给不出进度），
  // 空值一路传到进度环走 indeterminate，绝不兜成 0（会被读成「卡在 0%」）。
  const generationProgress = computed<number | null>(() => drawEngine.value === 'sd'
    ? (sd.progress.value === null ? null : sd.progress.value / 100)
    : animaState.value.progress)
  const generationError = computed(() => drawEngine.value === 'sd' ? sd.errorMsg.value : animaState.value.errorMsg)
  const generationStopped = computed(() => drawEngine.value === 'sd' ? sd.statusText.value === '已停止' : animaState.value.phase === 'cancelled')
  const generationPhase = computed<AnimaPhase>(() => drawEngine.value !== 'sd' ? animaState.value.phase
    : sd.generating.value ? 'running' : sd.errorMsg.value ? 'failed' : generationStopped.value ? 'cancelled' : 'idle')
  const generationNeedsReview = computed(() => drawEngine.value !== 'sd' && animaState.value.phase === 'failed' && animaState.value.backendStatus === 'unknown')
  const engineStatusText = computed(() => {
    if (drawEngine.value === 'sd') return 'SD 未连接'
    return animaState.value.checkMsg || `${drawEngineLabel.value} 未连接`
  })

  async function recheckEngineConnection() {
    if (drawEngine.value === 'sd') {
      const ok = await sd.checkStatus()
      flash(ok ? 'SD 已重新连接' : 'SD 仍未连接，请检查控制面板')
      return
    }
    await refreshAnimaBackend()
    flash(animaState.value.checkMsg)
  }
  const generationPresetSummary = computed(() => {
    if (drawEngine.value === 'sd') {
      const upscaler = pb.sdParams.hiresUpscaler === 'Auto' ? 'Auto Anime6B/Latent' : pb.sdParams.hiresUpscaler
      const hires = pb.sdParams.hiresFix
        ? ` · Hires ${upscaler} ${pb.sdParams.hiresScale}× / ${pb.sdParams.hiresSteps} steps / ${pb.sdParams.hiresDenoise}`
        : ''
      return `${pb.sdParams.steps} steps · CFG ${pb.sdParams.cfg} · ${pb.sdParams.sampler || '自动采样'} · ${sdSize.value}${hires}`
    }
    return `${animaState.value.steps} steps · CFG ${animaState.value.cfg} · ${animaState.value.sampler} / ${animaState.value.scheduler} · ${animaState.value.width}×${animaState.value.height}`
  })

  function cancelGeneration() {
    if (drawEngine.value === 'sd') sd.cancel()
    else void cancelAnimaJob()
  }

  // 去原生化的连带清理（2026-09-22）：原签名读 event.target.value，
  // 是原生 <select> 的产物；改用 StudioSelect 后回写的就是模型 id。
  function selectAnimaModel(modelId: string) {
    applyModel(modelId)
  }

  function updateAnimaPromptState() {
    patchAnimaState({
      prompt: livePrompt.value,
      negative: effectiveNegative.value,
    })
  }

  function buildAnimaRequest(preview = false): AnimaRequest | null {
    try {
      const request = buildBoundAnimaRequest({ subject: pb.subject, char: pb.char, state: animaState.value,
        profile: pb.isPopular ? popularProfile.value : modelProfile.value,
        prompt: livePrompt.value, negative: effectiveNegative.value })
      if (!preview) updateAnimaPromptState()
      return request
    } catch (error) {
      if (!preview) flash(error instanceof Error ? error.message : '当前绘图配置无法生成')
      return null
    }
  }

  return {
    currentCapabilities,
    animaNoLoraMode,
    supportsDualCharacter,
    setDrawEngine,
    applyRecommendedSize,
    onAnimaResult,
    clearDisplayedResult,
    displayResultUrl,
    displayResultSeed,
    drawEngineLabel,
    generationStatusText,
    engineOnline,
    generationBusy,
    generationProgress,
    generationError,
    generationStopped,
    generationPhase,
    generationNeedsReview,
    engineStatusText,
    recheckEngineConnection,
    generationPresetSummary,
    cancelGeneration,
    selectAnimaModel,
    updateAnimaPromptState,
    buildAnimaRequest,
  }
}

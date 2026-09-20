import { computed, type Ref } from 'vue'
import {
  closestSupportedSize,
  ANIMA_LORA_BY_CHARACTER,
  ANIMA_CHARACTER_BY_CHARACTER,
  type AnimaRequest,
} from '@/composables/generation/useAnimaSession'
import type { useAnimaSession } from '@/composables/generation/useAnimaSession'
import type { useSDGenerate } from '@/composables/generation/useSDGenerate'
import type { usePromptAssembly } from '@/composables/prompt/usePromptAssembly'
import type { useUnifiedPromptAssembly } from '@/composables/useUnifiedPromptAssembly'
import type { AnimaResult } from '@/types/anima'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { resolveDrawCapabilities } from '@/utils/drawCapabilities'
import {
  DRAW_ENGINE_SETTING,
  settingsRepository,
  type DrawEngine,
} from '@/storage/settingsRepository'

type PromptBuilderStore = ReturnType<typeof usePromptBuilderStore>
type SDGenerate = ReturnType<typeof useSDGenerate>
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

  /** 热门角色 Anima 无 LoRA：仅 popular subject + 选中底模的 noLora capability 时成立。 */
  const animaNoLoraMode = computed(() => {
    if (!pb.isPopular) return false
    if (!currentCapabilities.value.lora) return false
    const selected = animaState.value.models.find(model => model.id === animaState.value.modelId)
    return selected?.capabilities?.noLora === true
  })

  /** 引擎按钮禁用态由能力表驱动（双人支持等）。 */
  function supportsDualCharacter(engine: DrawEngine): boolean {
    return resolveDrawCapabilities(engine).dualCharacter
  }

  function setDrawEngine(v: DrawEngine, options: { silent?: boolean } = {}) {
    if (v === 'sd' && pb.isPopular) {
      flash('热门角色仅支持 Anima 无 LoRA 或 Krea 2，请保留 Comfy 引擎')
      return
    }
    if (!supportsDualCharacter(v) && pb.char === 'triad' && !pb.isPopular) {
      flash(v === 'krea2' ? 'Krea 2 首版暂不支持双角色身份构图，请使用 SD 引擎' : 'Anima 首版暂不支持双角色身份构图，请使用 SD 引擎')
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
    if (v !== 'sd') {
      syncAnimaCharacter(pb.char)
      void refreshAnimaBackend()
    }
    if (!options.silent) flash(v === 'anima'
      ? (pb.isPopular ? '已切换到 Anima Aesthetic（无 LoRA 热门角色模式）' : '已切换到 Anima 引擎（ComfyUI + 角色 LoRA）')
      : v === 'krea2' ? '已切换到 Krea 2（自然语言、无角色 LoRA，身份不保证）' : '已切换到 SD 引擎（WebUI）')
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
  const generationStatusText = computed(() => drawEngine.value === 'sd' ? sd.statusText.value : animaState.value.statusText)
  const engineOnline = computed(() => {
    if (drawEngine.value === 'anima') {
      if (pb.isPopular) return animaState.value.online && animaState.value.models.some(m => m.id === animaState.value.modelId && m.available !== false)
      return (currentCapabilities.value.dualCharacter || pb.char !== 'triad') && Boolean(animaState.value.loraId) && animaState.value.online
    }
    if (drawEngine.value === 'krea2') return animaState.value.online
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

  function selectAnimaModel(event: Event) {
    applyModel((event.target as HTMLSelectElement).value)
  }

  function updateAnimaPromptState() {
    patchAnimaState({
      prompt: livePrompt.value,
      negative: effectiveNegative.value,
    })
  }

  function buildAnimaRequest(): AnimaRequest | null {
    if (pb.isPopular) {
      return buildPopularRequest()
    }
    const profile = modelProfile.value
    if (pb.char === 'triad' && !currentCapabilities.value.dualCharacter) {
      flash(animaState.value.family === 'krea2' ? 'Krea 2 首版暂不支持双角色身份构图，请使用 SD 引擎' : 'Anima 首版暂不支持双角色身份构图，请使用 SD 引擎')
      return null
    }
    const charKey = pb.char === 'triad' ? null : pb.char
    if (!profile || profile.engine !== animaState.value.family || profile.model_id !== animaState.value.modelId) {
      flash('当前底模没有匹配的模型 profile，已拒绝生成')
      return null
    }
    const expectedLoraId = charKey ? ANIMA_LORA_BY_CHARACTER[charKey] : ''
    if (currentCapabilities.value.lora && currentCapabilities.value.characterIdentity && charKey && (animaState.value.loraId !== expectedLoraId || !animaState.value.loras.some(lora => lora.id === expectedLoraId && lora.available !== false))) {
      flash('Anima 底模尚未从服务端白名单发现')
      return null
    }
    updateAnimaPromptState()
    return {
      prompt: livePrompt.value,
      negative: effectiveNegative.value,
      profileId: profile.id || '',
      modelId: animaState.value.modelId,
      loraId: currentCapabilities.value.lora ? animaState.value.loraId : null,
      loraStrength: currentCapabilities.value.lora ? animaState.value.loraStrength : null,
      width: animaState.value.width,
      height: animaState.value.height,
      steps: animaState.value.steps,
      cfg: animaState.value.cfg,
      ...(animaState.value.seed == null ? {} : { seed: animaState.value.seed }),
      character: currentCapabilities.value.characterIdentity && charKey ? ANIMA_CHARACTER_BY_CHARACTER[charKey] : null,
      hiresFix: Boolean(animaState.value.hiresFix),
      hiresScale: animaState.value.hiresScale,
      hiresDenoise: animaState.value.hiresDenoise,
      teaCache: animaState.value.teaCache !== false,
      teaCacheThresh: animaState.value.teaCacheThresh,
      adultEnabled: pb.showMatureScenes,
    }
  }

  /** 热门角色无 LoRA 出图：Anima 只允许服务端声明的 noLora capability 底模；Krea 家族天然无 LoRA。 */
  function buildPopularRequest(): AnimaRequest | null {
    const profile = popularProfile.value
    if (!profile || profile.engine !== animaState.value.family || profile.model_id !== animaState.value.modelId) {
      flash('当前底模没有匹配的模型 profile，已拒绝生成')
      return null
    }
    if (!currentCapabilities.value.noLora) {
      flash('当前底模不支持无 LoRA 热门角色创作')
      return null
    }
    updateAnimaPromptState()
    return {
      prompt: livePrompt.value,
      negative: effectiveNegative.value,
      profileId: profile.id || '',
      modelId: animaState.value.modelId,
      loraId: null,
      loraStrength: null,
      width: animaState.value.width,
      height: animaState.value.height,
      steps: animaState.value.steps,
      cfg: animaState.value.cfg,
      ...(animaState.value.seed == null ? {} : { seed: animaState.value.seed }),
      character: null,
      hiresFix: Boolean(animaState.value.hiresFix),
      hiresScale: animaState.value.hiresScale,
      hiresDenoise: animaState.value.hiresDenoise,
      teaCache: animaState.value.teaCache !== false,
      teaCacheThresh: animaState.value.teaCacheThresh,
      adultEnabled: pb.showMatureScenes,
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
    engineStatusText,
    recheckEngineConnection,
    generationPresetSummary,
    cancelGeneration,
    selectAnimaModel,
    updateAnimaPromptState,
    buildAnimaRequest,
  }
}

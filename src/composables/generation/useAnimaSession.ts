import { computed, getCurrentInstance, onUnmounted, ref, watch } from 'vue'
import { ApiClientError, apiClient } from '@/api/client'
import type { AnimaGenerationState, AnimaOption, AnimaResult, AnimaResultContext } from '@/types/anima'
import type { CharKey } from '@/stores/promptBuilderStore'
import { useAnimaTask } from './useAnimaTask'
import { usePolling } from '@/composables/usePolling'
import { endfieldAnimaBinding } from '@/utils/loraCatalog'
import { readDrawingSettings, saveDrawingSettings } from '@/storage/drawingSettings'
import { backendReadiness } from './animaBackendReadiness'
import {
  ANIMA_LORA_BY_CHARACTER,
  closestSupportedSize,
  type AnimaRequest,
  type AnimaSessionOptions,
  type AnimaStatusResponse,
  type AnimaSubmission,
} from './animaSessionContract'
export { ANIMA_LORA_BY_CHARACTER, ANIMA_CHARACTER_BY_CHARACTER, animaRequestPayload, closestSupportedSize, resolveInpaintRequestBinding } from './animaSessionContract'
export type { AnimaRequest } from './animaSessionContract'

/**
 * Anima / Krea 2 生成会话 —— 生成、进度、取消和错误的会话内聚实现。
 *
 * 拥有 Anima 家族引擎的完整生命周期：后端发现与 15s 状态轮询、任务提交、
 * 轮询、取消、结果持有与卸载清理。导演台的 prompt 组装（buildAnimaRequest）
 * 和跨引擎协调（SD 结果互斥）通过注入的选项回调保留在视图侧。
 */

const BUSY_PHASES = ['submitting', 'running', 'cancelling']
const INITIAL_STATE: AnimaGenerationState = {
  phase: 'idle', progress: null, elapsedSeconds: 0, progressText: '', currentNode: null, online: false, checkMsg: 'Anima 状态检查中…', models: [], loras: [], styleLoras: [], styleLoraId: '',
  prompt: '', negative: '', modelId: 'anima-miaomiao-v1.6', loraId: 'L_NENE_V21_ANIMA',
  loraStrength: 0.85, width: 832, height: 1216, steps: 30, cfg: 4.5,
  family: 'anima',
  sampler: 'euler', scheduler: 'normal', seed: null,
  hiresFix: false, hiresScale: 2.0, hiresDenoise: 0.35, hiresUpscaler: 'Auto',
  teaCache: true, teaCacheThresh: 0.10,
  job: null, result: null, resultContext: null, statusText: '', errorMsg: '', errorReport: null,
}

export function initialAnimaState(family: 'anima' | 'krea2'): AnimaGenerationState {
  return { ...INITIAL_STATE, ...readDrawingSettings(family), family, models: [], loras: [], styleLoras: [] }
}

export function useAnimaSession(options: AnimaSessionOptions) {
  const client = options.client ?? apiClient
  const savedSettings = readDrawingSettings(options.getFamily())
  const state = ref<AnimaGenerationState>(initialAnimaState(options.getFamily()))
  let settingsRevision = 0, reconcilingSettings = false, teaCacheSettingsTouched = Boolean(savedSettings), loraStrengthTouched = Boolean(savedSettings)
  function persistSettings() {
    try { saveDrawingSettings(state.value) }
    catch { options.flash('绘图参数尚未保存，桌宠暂时无法同步这次设置，请检查本机资料连接') }
  }
  const editableKeys = ['family', 'modelId', 'loraId', 'loraStrength', 'styleLoraId', 'width', 'height',
    'steps', 'cfg', 'sampler', 'scheduler', 'seed', 'hiresFix', 'hiresScale', 'hiresDenoise', 'hiresUpscaler', 'teaCache', 'teaCacheThresh'] as const
  // Observe direct v-model writes as well as patchState, excluding only our
  // synchronous backend reconciliation, never the time spent awaiting status.
  const stopSettingsWatch = watch(editableKeys.map(key => () => state.value[key]), () => {
    if (!reconcilingSettings) { settingsRevision++; persistSettings() }
  }, { flush: 'sync' })
  const stopTeaCacheWatch = watch([() => state.value.teaCache, () => state.value.teaCacheThresh, () => state.value.loraStrength], (next, previous) => {
    if (!reconcilingSettings) {
      if (next[0] !== previous[0] || next[1] !== previous[1]) teaCacheSettingsTouched = true
      if (next[2] !== previous[2]) loraStrengthTouched = true
    }
  }, { flush: 'sync' })
  const getSettingsRevision = () => settingsRevision

  let statusRequest: AbortController | null = null
  let statusRefresh: Promise<boolean> | null = null
  let statusEpoch = 0, refreshSettingsRevision = 0
  let disposed = false
  const statusPolling = usePolling({ intervalMs: 15_000, immediate: false, paused: () => document.hidden,
    tick: async () => { await refreshBackend() } })

  /**
   * 上一次成功成片的临时缓冲（2026-09-06 体验报告 F2）。
   *
   * 旧行为：新一轮 generate() 一提交就 clearResult()——新请求哪怕网络失败，
   * 上一张未入册成片也连同 blob URL 一起销毁，用户无从找回。
   * 现在：提交前把当前结果连带冻结上下文移入 stash（不 revoke）；新结果成功
   * 才丢弃 stash；失败/取消时视图可提供「找回上一张」。stash 与舞台结果是
   * 两条独立生命线，互不 revoke。
   */
  const stashedResult = ref<{ result: AnimaResult; context: AnimaResultContext | null } | null>(null)

  const modelId = computed({
    get: () => state.value.modelId,
    set: value => applyModel(value),
  })

  function patchState(patch: Partial<AnimaGenerationState>) {
    if (!reconcilingSettings && 'loraStrength' in patch) loraStrengthTouched = true
    if (patch.provider && patch.provider !== state.value.provider && !('autoHiresModel' in patch)) patch = { ...patch, autoHiresModel: undefined }
    state.value = { ...state.value, ...patch }
  }

  function syncCharacter(character: CharKey = options.getCharacter()) {
    if (options.isPopular()) {
      const binding = endfieldAnimaBinding(options.getPopularCharacterId?.(), options.getFamily(), state.value.modelId)
      const available = binding && state.value.loras.some(lora => lora.id === binding.loraId && lora.available !== false)
      patchState({ loraId: available ? binding.loraId : '',
        ...(available && state.value.loraId !== binding.loraId ? { loraStrength: binding.loraStrength } : {}) })
      return
    }
    if (character === 'triad' || character === 'none') {
      patchState({ loraId: '' })
      return
    }
    const expected = ANIMA_LORA_BY_CHARACTER[character]
    const available = state.value.loras.some(lora => lora.id === expected && lora.available !== false)
    patchState({ loraId: available ? expected : '' })
  }

  /**
   * 记录「当前这套参数默认值属于哪个底模」（2026-08-30 UX 审计 P0-2）。
   * 底模默认值的施加只发生在两个时机：① 首次成功拉取后端；② 用户显式换底模
   * （applyModel）。15s 状态轮询**不再**重施默认值，否则用户刚调好的 CFG
   * 会在下一次心跳被静默改回。
   */
  let defaultsAppliedFor: string | null = savedSettings?.modelId ?? null

  function restoreSettings(patch: Partial<AnimaGenerationState>) {
    if ('teaCache' in patch || 'teaCacheThresh' in patch) teaCacheSettingsTouched = true
    defaultsAppliedFor = patch.modelId ?? state.value.modelId
    patchState(patch)
  }

  function modelDefaults(model: AnimaOption | undefined, provider = state.value.provider) {
    const defaults = model?.defaults
    return {
      steps: Number(defaults?.steps) || state.value.steps,
      cfg: Number(defaults?.cfg) || state.value.cfg,
      sampler: String(defaults?.sampler || state.value.sampler),
      scheduler: String(defaults?.scheduler || state.value.scheduler),
      ...(!state.value.provider && !loraStrengthTouched && provider === 'native' && !options.isPopular() && ['nene', 'natsume'].includes(options.getCharacter()) && typeof defaults?.loraStrength === 'number'
        ? { loraStrength: defaults.loraStrength } : {}),
      teaCache: teaCacheSettingsTouched ? state.value.teaCache : typeof defaults?.teaCache === 'boolean' ? defaults.teaCache : state.value.teaCache,
      teaCacheThresh: teaCacheSettingsTouched ? state.value.teaCacheThresh : typeof defaults?.teaCacheThresh === 'number' ? defaults.teaCacheThresh : state.value.teaCacheThresh,
    }
  }

  function applyModel(modelIdToApply: string) {
    const model = state.value.models.find(item => item.id === modelIdToApply)
    const size = closestSupportedSize(model, options.preferredSize() || `${state.value.width}x${state.value.height}`)
    const [width, height] = size.split('x').map(Number)
    defaultsAppliedFor = modelIdToApply
    patchState({
      modelId: modelIdToApply,
      family: model?.family === 'krea2' ? 'krea2' : 'anima',
      ...modelDefaults(model),
      styleLoraId: '',
      ...(Number.isInteger(width) && Number.isInteger(height) ? { width, height } : {}),
    })
    syncCharacter(options.getCharacter())
  }

  /**
   * 拉取 ComfyUI / 网关状态并按当前角色与引擎族收敛 model / lora 白名单。
   * 成功响应即使 offline 也采用（清空列表）；只有请求失败才标记离线。
   */
  // Awaiters follow a superseding refresh; false means the view cancelled discovery.
  function refreshBackend(checkedStatus?: AnimaStatusResponse): Promise<boolean> {
    if (disposed) return Promise.resolve(false)
    const family = options.getFamily()
    if (family !== state.value.family) {
      const stored = readDrawingSettings(family)
      reconcilingSettings = true
      try {
        patchState({ ...stored, family })
        defaultsAppliedFor = stored?.modelId ?? null
        teaCacheSettingsTouched = Boolean(stored); loraStrengthTouched = Boolean(stored)
      } finally { reconcilingSettings = false }
    }
    // Superseding discovery still belongs to the pending read's edit baseline.
    if (!statusRequest) refreshSettingsRevision = settingsRevision
    statusRequest?.abort()
    const controller = new AbortController()
    statusRequest = controller
    statusRefresh = readBackendStatus(controller, statusEpoch, refreshSettingsRevision, checkedStatus)
    return statusRefresh
  }

  async function readBackendStatus(controller: AbortController, epoch: number, initialSettingsRevision: number, checkedStatus?: AnimaStatusResponse): Promise<boolean> {
    const latest = () => epoch === statusEpoch && statusRequest !== controller ? statusRefresh ?? false : false
    try {
      const data = checkedStatus ?? await client.request<AnimaStatusResponse>('/api/creative/status', {
        cache: 'no-store', signal: controller.signal, timeoutMs: 10_000,
        validate: value => value.ok === true,
      })
      if (statusRequest !== controller || controller.signal.aborted) return latest()
      const models = Array.isArray(data.models) ? data.models : []
      const loras = (Array.isArray(data.loras) ? data.loras : [])
        .filter(lora => options.isPopular()
          ? lora.characters?.includes(options.getPopularCharacterId?.() || '')
          : options.getCharacter() !== 'none' && lora.character === options.getCharacter())
      const family = options.getFamily()
      const styleLoras = family === 'krea2' ? (data.styleLoras || []) : []
      const familyModels = models.filter(model => model.family === family)
      const visibleModels = options.isPopular() || options.getCharacter() === 'none'
        ? familyModels.filter(model => model.capabilities?.noLora === true
          && (!options.isPopular() || !endfieldAnimaBinding(options.getPopularCharacterId?.(), family)
            || endfieldAnimaBinding(options.getPopularCharacterId?.(), family, model.id)))
        : familyModels
      const modelIdCurrent = visibleModels.some(model => model.id === state.value.modelId)
        ? state.value.modelId
        : (visibleModels.find(model => model.available)?.id || visibleModels[0]?.id || '')
      const endfield = endfieldAnimaBinding(options.getPopularCharacterId?.(), family, modelIdCurrent)
      const familyLoras = family === 'krea2' ? [] : options.isPopular()
        ? loras.filter(lora => lora.id === endfield?.loraId) : loras
      const loraId = familyLoras.some(lora => lora.id === state.value.loraId)
        ? state.value.loraId
        : (familyLoras[0]?.id || '')
      const selectedModel = visibleModels.find(model => model.id === modelIdCurrent)
      // 切到新 family 时若当前尺寸不在该底模支持范围内，落到该底模推荐尺寸。
      // （Krea 与 Anima 尺寸白名单不同；否则请求会以 400 INVALID_PARAMETER 失败。）
      let width = state.value.width
      let height = state.value.height
      if (selectedModel && Array.isArray(selectedModel.sizes) && selectedModel.sizes.length
        && !selectedModel.sizes.includes(`${width}x${height}`)) {
        const [nextWidth, nextHeight] = String(selectedModel.sizes[0]).split('x').map(Number)
        if (Number.isInteger(nextWidth) && Number.isInteger(nextHeight)) { width = nextWidth; height = nextHeight }
      }
      /**
       * 底模默认值只在「换底模」时才重施（2026-08-30 UX 审计 P0-2）。
       *
       * 原实现每次心跳都无条件把 steps/cfg/sampler/scheduler 写成
       * selectedModel.defaults：底模没变时 defaults 是常量，用户把 CFG 从 5
       * 调到 7.5，15 秒内就被静默改回 5；styleLoraId 更是每次心跳无条件置空。
       * 现在：首次拉取 / 底模真的变了（用户换的，或原底模从后端消失导致的回落）
       * 才套用默认值，其余心跳只更新在线状态与候选列表。
       */
      const provider = data.provider === 'native' ? 'native' : 'comfy'
      const shouldApplyDefaults = (defaultsAppliedFor !== modelIdCurrent || (state.value.provider && state.value.provider !== provider)) && settingsRevision === initialSettingsRevision
      // 风格 LoRA 只在候选里已经不存在时才清空，而不是每 15 秒清一次
      const styleLoraId = styleLoras.some(lora => lora.id === state.value.styleLoraId)
        ? state.value.styleLoraId
        : ''
      reconcilingSettings = true
      try {
        patchState({
          ...backendReadiness(data, selectedModel, family, visibleModels.length, familyLoras.length),
          models: visibleModels, loras: familyLoras, styleLoras, styleLoraId, modelId: modelIdCurrent, loraId, width, height,
          ...(endfield && loraId === endfield.loraId && state.value.loraId !== loraId ? { loraStrength: endfield.loraStrength } : {}),
          family: selectedModel?.family === 'krea2' ? 'krea2' : 'anima',
          ...(shouldApplyDefaults ? modelDefaults(selectedModel, provider) : {}),
        })
        // An edit during discovery owns these defaults for this model, including later polls.
        defaultsAppliedFor = modelIdCurrent
        syncCharacter(options.getCharacter())
      } finally { reconcilingSettings = false }
      persistSettings()
      return true
    } catch (error) {
      if (statusRequest !== controller || controller.signal.aborted) return latest()
      if (error instanceof ApiClientError && error.kind === 'aborted') return false
      patchState({ online: false, managedStartAvailable: false, automaticMaskAvailable: false, automaticMaskStatus: undefined, autoHiresModel: undefined, checkMsg: `${options.getFamily() === 'krea2' ? 'Krea 2' : 'Anima'} 离线（网关状态接口不可用）` })
      return true
    } finally {
      if (statusRequest === controller) statusRequest = null
    }
  }

  function startStatusPolling() {
    stopStatusPolling()
    if (disposed) return
    document.addEventListener('visibilitychange', statusVisibilityChanged)
    if (!document.hidden) statusPolling.start()
  }

  function statusVisibilityChanged() {
    if (document.hidden) {
      statusPolling.stop()
      discardStatusRead()
    } else if (!statusPolling.isActive()) {
      statusPolling.start()
      void refreshBackend()
    }
  }

  function stopStatusPolling() {
    statusPolling.stop()
    document.removeEventListener('visibilitychange', statusVisibilityChanged)
  }

  function discardStatusRead() {
    statusEpoch++
    statusRefresh = null
    statusRequest?.abort()
    statusRequest = null
  }

  /** Health discovery is separate from accepted-job observation and result recovery. */
  function pauseStatusPolling() {
    stopStatusPolling()
    discardStatusRead()
  }

  function resetResult() {
    patchState({ result: null, job: null, progress: null, elapsedSeconds: 0, progressText: '', currentNode: null, resultContext: null })
  }

  function clearResult() {
    const previous = state.value.result
    if (previous) URL.revokeObjectURL(previous.url)
    resetResult()
  }

  /** generate 提交前调用：当前结果移入 stash（所有权移交，不 revoke）。 */
  function stashCurrentResult() {
    const current = state.value.result
    if (!current) return // 连续失败重试仍保留最近一次成功成片。
    if (stashedResult.value && stashedResult.value.result.url !== current.url) {
      URL.revokeObjectURL(stashedResult.value.result.url)
    }
    stashedResult.value = { result: current, context: state.value.resultContext ?? null }
    resetResult()
  }

  /** 新结果成功：stash 被超越，释放其 blob URL。 */
  function discardStashedResult() {
    if (stashedResult.value) URL.revokeObjectURL(stashedResult.value.result.url)
    stashedResult.value = null
  }

  /** 失败/取消后找回上一张：stash 回舞台，错误态复位为「已恢复」。 */
  function restoreStashedResult(): boolean {
    if (['submitting', 'running', 'cancelling'].includes(state.value.phase)) return false
    const stashed = stashedResult.value
    if (!stashed) return false
    stashedResult.value = null
    patchState({
      result: stashed.result,
      job: stashed.result.metadata,
      resultContext: stashed.context,
      phase: 'succeeded',
      progress: 1,
      statusText: '已恢复上一张未入册的成片',
      errorMsg: '',
      errorReport: null,
    })
    return true
  }

  function captureSubmission(overrides: Partial<AnimaRequest> = {}): AnimaSubmission | null {
    if (disposed || BUSY_PHASES.includes(state.value.phase)) return null
    const request = options.getRequest()
    return request ? JSON.parse(JSON.stringify({ family: state.value.family, request: { ...request, ...overrides }, context: options.getSubmitContext?.() ?? null })) as AnimaSubmission : null
  }

  const task = useAnimaTask(options, client, state, { capture: captureSubmission, patch: patchState,
    stash: stashCurrentResult, discardStashed: discardStashedResult })

  /** Leaving releases page observations and URLs; accepted execution belongs to the service. */
  function dispose() {
    disposed = true
    stopSettingsWatch()
    stopTeaCacheWatch()
    pauseStatusPolling()
    task.dispose()
    const result = state.value.result
    if (result) URL.revokeObjectURL(result.url)
    // stash 一并释放（blob 本体已在成功时写入临时成片记录，可跨页找回）。
    discardStashedResult()
  }

  // 在组件上下文里自动挂载清理；被普通函数调用时（非组件消费者）跳过
  if (getCurrentInstance()) onUnmounted(dispose)

  return {
    state,
    getSettingsRevision,
    modelId,
    patchState,
    restoreSettings,
    syncCharacter,
    applyModel,
    refreshBackend,
    startStatusPolling,
    stopStatusPolling,
    pauseStatusPolling,
    ...task,
    captureSubmission,
    clearResult,
    dispose,
    stashedResult,
    restoreStashedResult,
    discardStashedResult,
  }
}

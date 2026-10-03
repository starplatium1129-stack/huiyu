import { computed, getCurrentInstance, onUnmounted, ref, toRaw, watch } from 'vue'
import { ApiClientError, apiClient } from '@/api/client'
import type { AnimaGenerationState, AnimaResult, AnimaResultContext } from '@/types/anima'
import type { CharKey } from '@/stores/promptBuilderStore'
import { hasRuntimeTasks } from '@/api/runtimeTaskAuthority'
import { runtimeRequestKey } from '@/stores/runtimeTaskState'
import { usePolling } from '@/composables/usePolling'
import {
  ANIMA_LORA_BY_CHARACTER,
  animaRequestPayload,
  closestSupportedSize,
  jobPath,
  type AnimaRequest,
  type AnimaSessionOptions,
  type AnimaStatusResponse,
  type AnimaSubmission,
} from './animaSessionContract'
export * from './animaSessionContract'

/**
 * Anima / Krea 2 生成会话 —— 生成、进度、取消和错误的会话内聚实现。
 *
 * 拥有 Anima 家族引擎的完整生命周期：后端发现与 15s 状态轮询、任务提交、
 * 轮询、取消、结果持有与卸载清理。导演台的 prompt 组装（buildAnimaRequest）
 * 和跨引擎协调（SD 结果互斥）通过注入的选项回调保留在视图侧。
 */

const INITIAL_STATE: AnimaGenerationState = {
  phase: 'idle', progress: null, elapsedSeconds: 0, progressText: '', currentNode: null, online: false, checkMsg: 'Anima 状态检查中…', models: [], loras: [], styleLoras: [], styleLoraId: '',
  prompt: '', negative: '', modelId: 'anima-miaomiao-v1.6', loraId: 'L_NENE_V21_ANIMA',
  loraStrength: 0.85, width: 832, height: 1216, steps: 30, cfg: 4.5,
  family: 'anima',
  sampler: 'res_multistep', scheduler: 'simple', seed: null,
  hiresFix: false, hiresScale: 2.0, hiresDenoise: 0.35,
  teaCache: true, teaCacheThresh: 0.08,
  job: null, result: null, resultContext: null, statusText: '', errorMsg: '', errorReport: null,
}

export function useAnimaSession(options: AnimaSessionOptions) {
  const client = options.client ?? apiClient
  const state = ref<AnimaGenerationState>({ ...INITIAL_STATE })
  let settingsRevision = 0, reconcilingSettings = false
  const editableKeys = ['family', 'modelId', 'loraId', 'loraStrength', 'styleLoraId', 'width', 'height',
    'steps', 'cfg', 'sampler', 'scheduler', 'seed', 'hiresFix', 'hiresScale', 'hiresDenoise', 'teaCache', 'teaCacheThresh'] as const
  // Observe direct v-model writes as well as patchState, excluding only our
  // synchronous backend reconciliation, never the time spent awaiting status.
  const stopSettingsWatch = watch(editableKeys.map(key => () => state.value[key]), () => {
    if (!reconcilingSettings) settingsRevision++
  }, { flush: 'sync' })
  const getSettingsRevision = () => settingsRevision

  let requestSerial = 0
  let activeFamily: 'anima' | 'krea2' = 'anima'
  let statusRequest: AbortController | null = null
  let statusRefresh: Promise<boolean> | null = null
  let statusEpoch = 0, refreshSettingsRevision = 0
  let jobRequest: AbortController | null = null
  let durableAttempt = false, durableKey = ''
  let disposed = false
  const statusPolling = usePolling({ intervalMs: 15_000, immediate: false, paused: () => document.hidden,
    tick: async () => { await refreshBackend() } })
  let directTransport: typeof import('./animaJobPolling') | null = null
  async function loadDirectTransport() {
    // Cache only success: a missing deployment chunk must be retryable.
    return directTransport ??= await import('./animaJobPolling')
  }
  const completedSubmissions = new WeakMap<Blob, AnimaSubmission>()

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
  /** 本轮提交的冻结上下文（generate 采样 → 成功时落到 state.resultContext）。 */
  let pendingContext: AnimaResultContext | null = null

  const modelId = computed({
    get: () => state.value.modelId,
    set: value => applyModel(value),
  })

  function patchState(patch: Partial<AnimaGenerationState>) {
    state.value = { ...state.value, ...patch }
  }

  function syncCharacter(character: CharKey = options.getCharacter()) {
    if (options.isPopular()) {
      // 热门角色：无 LoRA 模式，不依赖角色 LoRA 白名单。
      patchState({ loraId: '' })
      return
    }
    if (character === 'triad') {
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
  let defaultsAppliedFor: string | null = null

  function restoreSettings(patch: Partial<AnimaGenerationState>) {
    defaultsAppliedFor = patch.modelId ?? state.value.modelId
    patchState(patch)
  }

  function applyModel(modelIdToApply: string) {
    const model = state.value.models.find(item => item.id === modelIdToApply)
    const size = closestSupportedSize(model, options.preferredSize() || `${state.value.width}x${state.value.height}`)
    const [width, height] = size.split('x').map(Number)
    defaultsAppliedFor = modelIdToApply
    patchState({
      modelId: modelIdToApply,
      family: model?.family === 'krea2' ? 'krea2' : 'anima',
      steps: Number(model?.defaults?.steps) || state.value.steps,
      cfg: Number(model?.defaults?.cfg) || state.value.cfg,
      sampler: String(model?.defaults?.sampler || state.value.sampler),
      scheduler: String(model?.defaults?.scheduler || state.value.scheduler),
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
  function refreshBackend(): Promise<boolean> {
    if (disposed) return Promise.resolve(false)
    // Superseding discovery still belongs to the pending read's edit baseline.
    if (!statusRequest) refreshSettingsRevision = settingsRevision
    statusRequest?.abort()
    const controller = new AbortController()
    statusRequest = controller
    statusRefresh = readBackendStatus(controller, statusEpoch, refreshSettingsRevision)
    return statusRefresh
  }

  async function readBackendStatus(controller: AbortController, epoch: number, initialSettingsRevision: number): Promise<boolean> {
    const latest = () => epoch === statusEpoch && statusRequest !== controller ? statusRefresh ?? false : false
    try {
      const data = await client.request<AnimaStatusResponse>('/api/creative/status', {
        cache: 'no-store', signal: controller.signal, timeoutMs: 10_000,
        validate: value => value.ok === true,
      })
      if (statusRequest !== controller || controller.signal.aborted) return latest()
      const models = Array.isArray(data.models) ? data.models : []
      const loras = (Array.isArray(data.loras) ? data.loras : [])
        .filter(lora => lora.character === options.getCharacter())
      const family = options.getFamily()
      const styleLoras = family === 'krea2' ? (data.styleLoras || []) : []
      const familyModels = models.filter(model => model.family === family)
      const visibleModels = options.isPopular()
        // 热门角色只暴露 no-LoRA 底模（Krea 家族天然无 LoRA，后端已声明 noLora:true）。
        ? familyModels.filter(model => model.capabilities?.noLora === true)
        : familyModels
      const familyLoras = family === 'krea2' ? [] : (options.isPopular() ? [] : loras)
      const modelIdCurrent = visibleModels.some(model => model.id === state.value.modelId)
        ? state.value.modelId
        : (visibleModels.find(model => model.available)?.id || visibleModels[0]?.id || '')
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
      const familyLabel = family === 'krea2' ? 'Krea 2' : 'Anima'
      const online = data.online === true && selectedModel?.available === true
      /**
       * 底模默认值只在「换底模」时才重施（2026-08-30 UX 审计 P0-2）。
       *
       * 原实现每次心跳都无条件把 steps/cfg/sampler/scheduler 写成
       * selectedModel.defaults：底模没变时 defaults 是常量，用户把 CFG 从 5
       * 调到 7.5，15 秒内就被静默改回 5；styleLoraId 更是每次心跳无条件置空。
       * 现在：首次拉取 / 底模真的变了（用户换的，或原底模从后端消失导致的回落）
       * 才套用默认值，其余心跳只更新在线状态与候选列表。
       */
      const shouldApplyDefaults = defaultsAppliedFor !== modelIdCurrent && settingsRevision === initialSettingsRevision
      // 风格 LoRA 只在候选里已经不存在时才清空，而不是每 15 秒清一次
      const styleLoraId = styleLoras.some(lora => lora.id === state.value.styleLoraId)
        ? state.value.styleLoraId
        : ''
      reconcilingSettings = true
      try {
        patchState({
          online,
          checkMsg: online
            ? `${familyLabel} 在线 · ${visibleModels.length} 个底模 · ${familyLoras.length} 个 LoRA`
            : `${familyLabel} 不可用（请检查 ComfyUI 与当前模型文件）`,
          models: visibleModels, loras: familyLoras, styleLoras, styleLoraId, modelId: modelIdCurrent, loraId, width, height,
          family: selectedModel?.family === 'krea2' ? 'krea2' : 'anima',
          steps: shouldApplyDefaults ? (Number(selectedModel?.defaults?.steps) || state.value.steps) : state.value.steps,
          cfg: shouldApplyDefaults ? (Number(selectedModel?.defaults?.cfg) || state.value.cfg) : state.value.cfg,
          sampler: shouldApplyDefaults ? String(selectedModel?.defaults?.sampler || state.value.sampler) : state.value.sampler,
          scheduler: shouldApplyDefaults ? String(selectedModel?.defaults?.scheduler || state.value.scheduler) : state.value.scheduler,
        })
        // An edit during discovery owns these defaults for this model, including later polls.
        defaultsAppliedFor = modelIdCurrent
        syncCharacter(options.getCharacter())
      } finally { reconcilingSettings = false }
      return true
    } catch (error) {
      if (statusRequest !== controller || controller.signal.aborted) return latest()
      if (error instanceof ApiClientError && error.kind === 'aborted') return false
      patchState({ online: false, checkMsg: `${options.getFamily() === 'krea2' ? 'Krea 2' : 'Anima'} 离线（网关状态接口不可用）` })
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

  function clearResult() {
    const previous = state.value.result
    if (previous) URL.revokeObjectURL(previous.url)
    patchState({ result: null, job: null, progress: null, elapsedSeconds: 0, progressText: '', currentNode: null, resultContext: null })
  }

  /** generate 提交前调用：当前结果移入 stash（所有权移交，不 revoke）。 */
  function stashCurrentResult() {
    const current = state.value.result
    if (!current) return // 连续失败重试仍保留最近一次成功成片。
    if (stashedResult.value && stashedResult.value.result.url !== current?.url) {
      URL.revokeObjectURL(stashedResult.value.result.url)
    }
    stashedResult.value = current
      ? { result: current, context: state.value.resultContext ?? null }
      : null
    patchState({ result: null, job: null, progress: null, elapsedSeconds: 0, progressText: '', currentNode: null, resultContext: null })
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
    if (disposed || ['submitting', 'running', 'cancelling'].includes(state.value.phase)) return null
    const request = options.getRequest()
    return request ? JSON.parse(JSON.stringify({ family: state.value.family, request: { ...request, ...overrides }, context: options.getSubmitContext?.() ?? null })) as AnimaSubmission : null
  }

  function resultSubmission(): AnimaSubmission | null {
    const result = state.value.result
    const submission = result && completedSubmissions.get(toRaw(result.blob))
    if (!result || !submission || !Number.isSafeInteger(result.metadata.seed) || result.metadata.seed < 0) return null
    return JSON.parse(JSON.stringify({ ...submission, request: { ...submission.request, seed: result.metadata.seed } })) as AnimaSubmission
  }

  async function generate(overrides: Partial<AnimaRequest> = {}, frozen?: AnimaSubmission): Promise<void> {
    if (disposed || ['submitting', 'running', 'cancelling'].includes(state.value.phase)) return
    const submission = frozen ? JSON.parse(JSON.stringify({ ...frozen, request: { ...frozen.request, ...overrides } })) as AnimaSubmission : captureSubmission(overrides)
    if (!submission) return
    if (frozen && submission.family !== options.getFamily()) { options.flash('创作引擎已更换，请重新确认后提交'); return }
    const { request, family } = submission
    if (!state.value.online) { options.flash('Anima ComfyUI 当前未连接'); return }
    const serial = ++requestSerial
    activeFamily = family
    jobRequest?.abort()
    const controller = new AbortController()
    jobRequest = controller
    durableAttempt = hasRuntimeTasks(); durableKey = ''
    pendingContext = JSON.parse(JSON.stringify(submission.context)) as AnimaResultContext | null
    const onResult = (result: AnimaResult) => { completedSubmissions.set(toRaw(result.blob), JSON.parse(JSON.stringify(submission)) as AnimaSubmission); options.onResult(result) }
    // F2：提交不再销毁上一张成片——移入 stash，失败/取消可找回（见 stashedResult）。
    stashCurrentResult()
    patchState({ phase: 'submitting', job: null, currentNode: null, resultContext: null, progress: null, elapsedSeconds: 0, progressText: '正在连接 ComfyUI…', statusText: '提交任务…', errorMsg: '', errorReport: null })
    let accepted = false
    try {
      if (durableAttempt) {
        const kind = family === 'krea2' ? 'creative' : 'anima'
        const input = animaRequestPayload(request)
        durableKey = runtimeRequestKey(kind, input)
        const { runRuntimeAnima } = await import('./runtimeImageSession')
        await runRuntimeAnima({ input, key: durableKey, signal: controller.signal, family, context: pendingContext, state,
          isCurrent: () => !controller.signal.aborted && serial === requestSerial,
          onAccepted: () => { accepted = true }, discardStashed: discardStashedResult, onResult })
        return
      }
      // Load the complete direct transport before creating an upstream job.
      const transport = await loadDirectTransport()
      const current = () => !controller.signal.aborted && serial === requestSerial
      if (!current()) return
      await transport.runDirectAnima({ client, request, family, signal: controller.signal, current,
        state, context: pendingContext, patch: patchState, discardStashed: discardStashedResult, onResult })
    } catch (error) {
      if (serial !== requestSerial) return
      if (durableAttempt) {
        const { runtimeAnimaFailure } = await import('./runtimeImageSession')
        if (serial === requestSerial) patchState(runtimeAnimaFailure(error, controller.signal.aborted, accepted))
        return
      }
      if (controller.signal.aborted) {
        patchState({ phase: 'cancelled', statusText: '已停止提交', errorMsg: '', errorReport: null })
        return
      }
      if (error instanceof ApiClientError && error.kind === 'aborted') return
      const { imageFailurePatch } = await import('./runtimeImageSession')
      if (serial === requestSerial) patchState(imageFailurePatch(error, '生成失败'))
    } finally {
      if (jobRequest === controller) jobRequest = null
    }
  }

  async function cancel(): Promise<void> {
    if (durableAttempt && durableKey && ['submitting', 'running', 'cancelling'].includes(state.value.phase)) {
      const serial = requestSerial, key = durableKey
      const isCurrent = () => serial === requestSerial && key === durableKey && ['submitting', 'running', 'cancelling'].includes(state.value.phase)
      patchState({ phase: 'cancelling', statusText: '正在记录取消请求…' })
      try {
        const { cancelRuntimeTaskKey, taskMessage } = await import('@/api/runtimeTasks')
        const task = await cancelRuntimeTaskKey(key)
        if (!isCurrent()) return
        patchState({ phase: task?.status === 'cancelled' ? 'cancelled' : 'cancelling', statusText: task ? taskMessage(task) : '取消意图已记录，等待提交核对。' })
      } catch { if (isCurrent()) patchState({ statusText: '取消尚未确认，请到任务中心核对。' }) }
      return
    }
    const job = state.value.job
    if (state.value.phase === 'submitting') {
      // Invalidate first: a late POST must not overwrite a restored result.
      // If an accepted ID still arrives, generate() cleans it up by family.
      requestSerial += 1
      jobRequest?.abort()
      patchState({ phase: 'cancelled', statusText: '已停止提交', errorMsg: '', errorReport: null })
      return
    }
    if (!job || !['running', 'cancelling'].includes(state.value.phase)) return
    const serial = requestSerial
    const family = activeFamily
    const isCurrent = () => serial === requestSerial && state.value.job?.id === job.id
      && ['running', 'cancelling'].includes(state.value.phase)
    patchState({ phase: 'cancelling', statusText: '取消中…', errorMsg: '', errorReport: null })
    try {
      const transport = directTransport ?? await loadDirectTransport()
      if (!isCurrent()) return
      await transport.cancelDirectAnima({ client, id: job.id, family, current: isCurrent, patch: patchState,
        cancelled: () => { requestSerial += 1; jobRequest?.abort() } })
    } catch (error) {
      if (isCurrent()) patchState({ statusText: '取消工具加载失败，请重试取消', errorMsg: error instanceof Error ? error.message : String(error) })
    }
  }

  /** 离开导演台：停止轮询、取消在途任务、释放结果 URL（防止 GPU 任务悬挂与 blob 泄漏） */
  function dispose() {
    disposed = true
    stopSettingsWatch()
    requestSerial += 1
    pauseStatusPolling()
    jobRequest?.abort()
    jobRequest = null
    const activeJob = state.value.job
    if (!durableAttempt && activeJob && ['running', 'cancelling'].includes(state.value.phase)) {
      void client.request<{ ok?: boolean }>(jobPath(activeFamily, activeJob.id), { method: 'DELETE', timeoutMs: 10_000 }).catch(() => {})
    }
    const result = state.value.result
    if (result) URL.revokeObjectURL(result.url)
    // stash 一并释放（blob 本体已在成功时写入临时成片记录，可跨页找回）。
    discardStashedResult()
  }

  // 在组件上下文里自动挂载清理；被普通函数调用时（如测试）跳过
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
    generate,
    captureSubmission,
    resultSubmission,
    cancel,
    clearResult,
    dispose,
    stashedResult,
    restoreStashedResult,
    discardStashedResult,
  }
}

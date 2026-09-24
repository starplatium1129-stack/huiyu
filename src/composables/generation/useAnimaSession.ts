import { computed, getCurrentInstance, onUnmounted, ref } from 'vue'
import { ApiClientError, apiClient, type ApiClient } from '@/api/client'
import type {
  AnimaGenerationState,
  AnimaJobMetadata,
  AnimaOption,
  AnimaResult,
  AnimaResultContext,
} from '@/types/anima'
import type { CharKey } from '@/stores/promptBuilderStore'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { classifySDError } from '@/utils/sdError'

/**
 * Anima / Krea 2 生成会话 —— 生成、进度、取消和错误的会话内聚实现。
 *
 * 拥有 Anima 家族引擎的完整生命周期：后端发现与 15s 状态轮询、任务提交、
 * 轮询、取消、结果持有与卸载清理。导演台的 prompt 组装（buildAnimaRequest）
 * 和跨引擎协调（SD 结果互斥）通过注入的选项回调保留在视图侧。
 */

export interface AnimaPublicJob {
  id: string
  status: 'queued' | AnimaGenerationState['phase']
  progress?: number | null
  elapsedSeconds?: number
  progressText?: string
  currentNode?: string | null
  seed: number
  resultAvailable: boolean
  resultUrl: string | null
  metadata?: AnimaJobMetadata
  error: string | null
  code: string | null
}

export interface AnimaStatusResponse {
  ok?: boolean
  online?: boolean
  models?: AnimaOption[]
  loras?: AnimaOption[]
  styleLoras?: AnimaGenerationState['styleLoras']
  error?: string
}

export interface AnimaRequest {
  prompt: string
  negative: string
  profileId: string
  modelId: string
  loraId: string | null
  loraStrength: number | null
  width: number
  height: number
  steps: number
  cfg: number
  seed?: number
  character: 'nene' | 'natsume' | 'triad' | null
  styleLoraId?: string
  hiresFix?: boolean
  hiresScale?: number
  hiresDenoise?: number
  teaCache?: boolean
  teaCacheThresh?: number
  initImage?: string
  maskImage?: string
  maskPrompt?: string
  maskThreshold?: number
  denoisingStrength?: number
  growMaskBy?: number
  adultEnabled?: boolean
}

export interface AnimaSessionOptions {
  getCharacter: () => CharKey
  isPopular: () => boolean
  /** 当前绘图表面的引擎族：'krea2' 或 'anima'（SD 时不调用） */
  getFamily: () => 'anima' | 'krea2'
  /** 视图侧 prompt 组装；返回 null 表示拒绝生成（内部已提示原因） */
  getRequest: () => AnimaRequest | null
  /**
   * 提交时冻结创作上下文（F3：角色/服装/蓝图/场景/故事）。在 generate() 的
   * 提交瞬间采样——任务跑多久、用户中途怎么改表单都不影响这张图的归属。
   */
  getSubmitContext?: () => AnimaResultContext | null
  /** 出图成功：视图做跨引擎协调（如清空 SD 结果） */
  onResult: (result: AnimaResult) => void
  flash: (message: string) => void
  /** applyModel 时优先采纳的推荐尺寸（如导演台 lastRecommendedSize） */
  preferredSize: () => string
  client?: ApiClient
}

const INITIAL_STATE: AnimaGenerationState = {
  phase: 'idle', progress: null, elapsedSeconds: 0, progressText: '', currentNode: null, online: false, checkMsg: 'Anima 状态检查中…', models: [], loras: [], styleLoras: [], styleLoraId: '',
  prompt: '', negative: '', modelId: 'anima-miaomiao-v1.2', loraId: 'L_NENE_V21_ANIMA',
  loraStrength: 0.85, width: 832, height: 1216, steps: 30, cfg: 4.5,
  family: 'anima',
  sampler: 'res_multistep', scheduler: 'simple', seed: null,
  hiresFix: false, hiresScale: 2.0, hiresDenoise: 0.35,
  teaCache: true, teaCacheThresh: 0.08,
  job: null, result: null, resultContext: null, statusText: '', errorMsg: '', errorReport: null,
}

export const ANIMA_LORA_BY_CHARACTER = {
  nene: 'L_NENE_V21_ANIMA',
  natsume: 'L_NAT_V21_ANIMA',
} as const

export const ANIMA_CHARACTER_BY_CHARACTER = {
  nene: 'nene',
  natsume: 'natsume',
} as const

export type InpaintCharacterMode = 'nene' | 'natsume' | 'none' | null

export interface InpaintRequestBinding {
  character: 'nene' | 'natsume' | null
  loraId: string | null
  modelId: string
  width: number
  height: number
}

export function resolveInpaintRequestBinding(
  models: AnimaOption[],
  currentModelId: string,
  character: InpaintCharacterMode,
  desiredSize: string,
): InpaintRequestBinding | null {
  const usesCharacterLora = character === 'nene' || character === 'natsume'
  const currentModel = models.find(model => model.id === currentModelId)
  const selectedModel = usesCharacterLora
    ? currentModel
    : (currentModel?.capabilities?.noLora === true
      ? currentModel
      : models.find(model => model.capabilities?.noLora === true))
  if (!selectedModel || (!usesCharacterLora && selectedModel.capabilities?.noLora !== true)) return null

  const outputSize = closestSupportedSize(selectedModel, desiredSize)
  const [width, height] = outputSize.split('x').map(Number)
  return {
    character: usesCharacterLora ? character : null,
    loraId: usesCharacterLora ? ANIMA_LORA_BY_CHARACTER[character] : null,
    modelId: selectedModel.id,
    width,
    height,
  }
}

function jobPath(family: 'anima' | 'krea2', id?: string): string {
  const base = family === 'krea2' ? '/api/creative/jobs' : '/api/anima/jobs'
  return id ? `${base}/${encodeURIComponent(id)}` : base
}

/** 请求载荷按服务端白名单收敛；空字段不发送（服务端 400 INVALID_PARAMETER） */
export function animaRequestPayload(
  request: AnimaRequest,
): Omit<AnimaRequest, 'profileId' | 'loraId' | 'loraStrength'> & Partial<Pick<AnimaRequest, 'loraId' | 'loraStrength'>> & { adultEnabled?: boolean } {
  // 成人内容传输层授权：本机/桌面端自动透传，服务端 fail-closed 双门校验
  const adultEnabled = request.adultEnabled !== undefined ? request.adultEnabled : isLocalStudioHost()
  return {
    prompt: request.prompt,
    negative: request.negative,
    modelId: request.modelId,
    ...(request.loraId ? { loraId: request.loraId, loraStrength: request.loraStrength } : {}),
    ...(request.styleLoraId ? { styleLoraId: request.styleLoraId } : {}),
    width: request.width,
    height: request.height,
    steps: request.steps,
    cfg: request.cfg,
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    character: request.character,
    ...(request.hiresFix ? {
      hiresFix: true,
      hiresScale: request.hiresScale || 2.0,
      hiresDenoise: request.hiresDenoise || 0.35,
    } : {}),
    ...(request.teaCache !== undefined ? { teaCache: request.teaCache } : {}),
    ...(request.teaCacheThresh !== undefined ? { teaCacheThresh: request.teaCacheThresh } : {}),
    ...(request.initImage ? { initImage: request.initImage } : {}),
    ...(request.maskImage ? { maskImage: request.maskImage } : {}),
    ...(request.maskPrompt ? { maskPrompt: request.maskPrompt } : {}),
    ...(request.maskPrompt && request.maskThreshold !== undefined ? { maskThreshold: request.maskThreshold } : {}),
    ...(request.denoisingStrength !== undefined ? { denoisingStrength: request.denoisingStrength } : {}),
    ...(request.growMaskBy !== undefined ? { growMaskBy: request.growMaskBy } : {}),
    ...(adultEnabled ? { adultEnabled: true } : {}),
  }
}

/** 目标尺寸不在底模白名单时，收敛到比例最接近的受支持尺寸 */
export function closestSupportedSize(
  model: { sizes?: ReadonlyArray<string> | string[] } | undefined,
  desired: string,
): string {
  const sizes = model?.sizes || []
  if (!sizes.length || sizes.includes(desired)) return desired
  const [desiredWidth, desiredHeight] = desired.split('x').map(Number)
  if (!desiredWidth || !desiredHeight) return sizes[0]
  const desiredRatio = desiredWidth / desiredHeight
  return [...sizes].sort((left, right) => {
    const [leftWidth, leftHeight] = left.split('x').map(Number)
    const [rightWidth, rightHeight] = right.split('x').map(Number)
    return Math.abs(leftWidth / leftHeight - desiredRatio) - Math.abs(rightWidth / rightHeight - desiredRatio)
  })[0]
}

export function useAnimaSession(options: AnimaSessionOptions) {
  const client = options.client ?? apiClient
  const state = ref<AnimaGenerationState>({ ...INITIAL_STATE })

  let statusTimer: ReturnType<typeof setInterval> | null = null
  let requestSerial = 0
  let activeFamily: 'anima' | 'krea2' = 'anima'
  let statusRequest: AbortController | null = null
  let jobRequest: AbortController | null = null

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
  async function refreshBackend(): Promise<void> {
    statusRequest?.abort()
    const controller = new AbortController()
    statusRequest = controller
    try {
      const data = await client.request<AnimaStatusResponse>('/api/creative/status', {
        cache: 'no-store', signal: controller.signal, timeoutMs: 10_000,
        validate: value => value.ok === true,
      })
      if (statusRequest !== controller || controller.signal.aborted) return
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
      const shouldApplyDefaults = defaultsAppliedFor !== modelIdCurrent
      // 风格 LoRA 只在候选里已经不存在时才清空，而不是每 15 秒清一次
      const styleLoraId = styleLoras.some(lora => lora.id === state.value.styleLoraId)
        ? state.value.styleLoraId
        : ''
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
      if (shouldApplyDefaults) defaultsAppliedFor = modelIdCurrent
      syncCharacter(options.getCharacter())
    } catch (error) {
      if (statusRequest !== controller || controller.signal.aborted) return
      if (error instanceof ApiClientError && error.kind === 'aborted') return
      patchState({ online: false, checkMsg: `${options.getFamily() === 'krea2' ? 'Krea 2' : 'Anima'} 离线（网关状态接口不可用）` })
    } finally {
      if (statusRequest === controller) statusRequest = null
    }
  }

  function startStatusPolling(intervalMs = 15_000) {
    stopStatusPolling()
    statusTimer = setInterval(() => { void refreshBackend() }, intervalMs) as unknown as ReturnType<typeof setInterval>
  }

  function stopStatusPolling() {
    if (statusTimer) clearInterval(statusTimer)
    statusTimer = null
  }

  /** Hidden/irrelevant workspaces stop health polling and discard its stale in-flight read. */
  function pauseStatusPolling() {
    stopStatusPolling()
    statusRequest?.abort()
    statusRequest = null
  }

  function metadataFromJob(job: AnimaPublicJob, request: AnimaRequest, family: 'anima' | 'krea2'): AnimaJobMetadata {
    const supplied = job.metadata
    const metadata = supplied && supplied.prompt === request.prompt && supplied.negative === request.negative
      ? supplied
      : {
          engine: family,
          id: job.id,
          prompt: request.prompt,
          negative: request.negative,
          profileId: request.profileId,
          modelId: request.modelId,
          loraId: request.loraId,
          loraStrength: request.loraStrength,
          styleLoraId: request.styleLoraId ?? null,
          width: request.width,
          height: request.height,
          steps: request.steps,
          cfg: request.cfg,
          sampler: state.value.sampler,
          scheduler: state.value.scheduler,
          seed: job.seed,
          character: request.character,
          preview: false,
          hiresFix: Boolean(request.hiresFix),
          hiresScale: request.hiresScale,
          hiresDenoise: request.hiresDenoise,
          createdAt: Date.now(),
          resultUrl: job.resultUrl,
        }
    return Object.freeze({ ...metadata, resultUrl: job.resultUrl || metadata.resultUrl || null }) as AnimaJobMetadata
  }


  async function pollJob(jobId: string, request: AnimaRequest, family: 'anima' | 'krea2', serial: number, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + 10 * 60 * 1000
    while (Date.now() < deadline && serial === requestSerial) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      if (serial !== requestSerial) return
      let data: { ok?: boolean; job?: AnimaPublicJob; error?: string }
      try {
        data = await client.request<{ ok?: boolean; job?: AnimaPublicJob; error?: string }>(jobPath(family, jobId), {
          cache: 'no-store', signal, timeoutMs: 15_000,
        })
      } catch (error) {
        if (serial !== requestSerial || signal.aborted) return
        if (error instanceof ApiClientError && (error.kind === 'network' || error.kind === 'timeout' || (error.kind === 'http' && error.status >= 500))) {
          patchState({ progressText: '连接暂时中断，正在重新读取任务进度…' })
          continue
        }
        throw error
      }
      if (serial !== requestSerial) return
      const job = data.job
      if (data.ok !== true || !job) throw new Error(data.error || 'Anima 状态无效')
      if (job.metadata) patchState({ job: metadataFromJob(job, request, family) })
      patchState({
        backendStatus: job.status,
        progress: typeof job.progress === 'number' ? Math.max(0, Math.min(1, job.progress)) : null,
        elapsedSeconds: typeof job.elapsedSeconds === 'number' ? Math.max(0, job.elapsedSeconds) : state.value.elapsedSeconds,
        progressText: typeof job.progressText === 'string' ? job.progressText : state.value.progressText,
        currentNode: typeof job.currentNode === 'string' ? job.currentNode : state.value.currentNode,
      })
      if (job.status === 'cancelling') {
        patchState({ phase: 'cancelling', statusText: '取消中…' })
        continue
      }
      if (job.status === 'cancelled') {
        patchState({ phase: 'cancelled', statusText: '任务已取消', errorMsg: '' })
        return
      }
      if (job.status === 'failed') throw new Error(job.error || 'Anima 生成失败')
      if (job.status !== 'succeeded' || !job.resultAvailable || !job.resultUrl) continue

      const { fetchResultImage } = await import('./fetchResultImage.ts')
      const blob = await fetchResultImage(job.resultUrl, signal)
      if (serial !== requestSerial) return
      const metadata = metadataFromJob(job, request, family)
      const result: AnimaResult = { url: URL.createObjectURL(blob), blob, metadata }
      // 会话拥有成功态与结果持有：先释放旧结果再写入新结果。
      const previous = state.value.result
      if (previous && previous.url !== result.url) URL.revokeObjectURL(previous.url)
      // 新成片落地即超越 stash（上一张未入册成片由临时缓冲/作品册接管）。
      discardStashedResult()
      patchState({ result, job: metadata, resultContext: pendingContext, phase: 'succeeded', progress: 1, progressText: '生成完成', currentNode: null, statusText: '生成完成', errorMsg: '', errorReport: null })
      options.onResult(result)
      return
    }
    if (serial === requestSerial) {
      // A deadline ends this attempt; cleanup must not publish into a retry.
      void client.request(jobPath(family, jobId), { method: 'DELETE', timeoutMs: 10_000 }).catch(() => {})
      throw new Error('Anima 生成超时，已请求取消上游任务')
    }
  }

  /**
   * 失败态统一落法（2026-08-30 UX 审计）。
   *
   * Anima / Krea 2 走 ComfyUI，后端失败信息是英文技术串（节点名、张量形状、
   * traceback）。此前原样直出——用户看不懂，也没有任何重试入口，与 SD 路径
   * 的「分类 + 恢复动作」形成体验断层。
   *
   * 现在与 SD 共用 sdError 分类器（backend='comfy' 保证文案不提 WebUI），
   * errorMsg 给中文结论，errorReport 让面板能显示标题、建议与折叠的技术细节。
   * errorMsg 保留分类后的可读文案而非原始串——调用方（导演台 generationError、
   * 面板红字）都只是展示给用户看。
   */
  function failurePatch(error: unknown, statusText: string) {
    const report = classifySDError(error, 'comfy')
    return {
      phase: 'failed' as const,
      statusText,
      errorMsg: report.kind === 'cancelled' ? report.message : `${report.title}：${report.message}`,
      errorReport: report,
    }
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

  async function generate(overrides: Partial<AnimaRequest> = {}): Promise<void> {
    if (['submitting', 'running', 'cancelling'].includes(state.value.phase)) return
    const baseRequest = options.getRequest()
    if (!baseRequest) return
    const request: AnimaRequest = { ...baseRequest, ...overrides }
    if (!state.value.online) { options.flash('Anima ComfyUI 当前未连接'); return }
    const serial = ++requestSerial
    const family = state.value.family
    activeFamily = family
    jobRequest?.abort()
    const controller = new AbortController()
    jobRequest = controller
    const context = options.getSubmitContext?.()
    pendingContext = context ? JSON.parse(JSON.stringify(context)) as AnimaResultContext : null
    // F2：提交不再销毁上一张成片——移入 stash，失败/取消可找回（见 stashedResult）。
    stashCurrentResult()
    patchState({ phase: 'submitting', job: null, currentNode: null, resultContext: null, progress: null, elapsedSeconds: 0, progressText: '正在连接 ComfyUI…', statusText: '提交任务…', errorMsg: '', errorReport: null })
    try {
      const data = await client.request<{ ok?: boolean; job?: AnimaPublicJob; error?: string }>(jobPath(family), {
        method: 'POST',
        body: animaRequestPayload(request),
        signal: controller.signal,
        timeoutMs: 30_000,
      })
      if (data.ok !== true || !data.job?.id) throw new Error(data.error || 'Anima 任务创建失败')
      if (controller.signal.aborted || serial !== requestSerial) {
        // A cancel can race the POST response. Once the server has accepted a
        // job, delete that late job instead of leaving an unowned GPU task.
        void client.request(jobPath(family, data.job.id), { method: 'DELETE', timeoutMs: 10_000 }).catch(() => {})
        if (serial === requestSerial && controller.signal.aborted) {
          patchState({ phase: 'cancelled', statusText: '已停止提交', errorMsg: '', errorReport: null })
        }
        return
      }
      const metadata = metadataFromJob(data.job, request, family)
      patchState({ phase: 'running', backendStatus: data.job.status, statusText: '生成中…', job: metadata })
      await pollJob(data.job.id, request, family, serial, controller.signal)
    } catch (error) {
      if (serial !== requestSerial) return
      if (controller.signal.aborted) {
        patchState({ phase: 'cancelled', statusText: '已停止提交', errorMsg: '', errorReport: null })
        return
      }
      if (error instanceof ApiClientError && error.kind === 'aborted') return
      patchState(failurePatch(error, '生成失败'))
    } finally {
      if (jobRequest === controller) jobRequest = null
    }
  }

  async function cancel(): Promise<void> {
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
      const data = await client.request<{ job?: AnimaPublicJob }>(jobPath(family, job.id), {
        method: 'DELETE', timeoutMs: 15_000,
      })
      if (!isCurrent()) return
      if (data.job?.status === 'cancelled') {
        requestSerial += 1
        jobRequest?.abort()
        patchState({ phase: 'cancelled', statusText: '任务已取消' })
      }
    } catch (error) {
      if (!isCurrent()) return
      patchState({ statusText: '取消尚未确认，正在继续查询任务', errorMsg: error instanceof Error ? error.message : '取消请求失败' })
    }
  }

  /** 离开导演台：停止轮询、取消在途任务、释放结果 URL（防止 GPU 任务悬挂与 blob 泄漏） */
  function dispose() {
    requestSerial += 1
    statusRequest?.abort()
    statusRequest = null
    jobRequest?.abort()
    jobRequest = null
    stopStatusPolling()
    const activeJob = state.value.job
    if (activeJob && ['running', 'cancelling'].includes(state.value.phase)) {
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
    cancel,
    clearResult,
    dispose,
    stashedResult,
    restoreStashedResult,
    discardStashedResult,
  }
}

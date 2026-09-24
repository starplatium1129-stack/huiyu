import { ref, readonly, onUnmounted, getCurrentInstance } from 'vue'
import type { SDGenerateParams } from '@/utils/sdRequest'
import {
  parseSDOptionList,
  parseSDStatus,
} from '@/utils/sdStatus'
import { mediaStatusApi } from '@/api/mediaStatusApi'
import { generationApi } from '@/api/generationApi'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
export type { SDGenerateParams } from '@/utils/sdRequest'

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useSDGenerate() {
  const online      = ref(false)
  const checkpoint  = ref('')
  const generating  = ref(false)
  const taskState = ref('idle')
  /**
   * 0–100 的真实进度；`null` = 后端给不出进度（WebUI 路径 / 尚未收到步骤事件）。
   * 保持可空而非默认 0：UI 的进度环对 null 走 indeterminate 动画，对 0 则画一个
   * 静止的空环——后者会被读成「卡在 0%」。**不伪造匀速增量**（审计保持项）。
   */
  const progress    = ref<number | null>(null)
  const statusText  = ref('')
  const resultUrl   = ref('')
  const resultSeed  = ref<number | null>(null)
  /** 当前结果图实际提交生成时使用的正向提示词（出视频/存历史按图取词，不随面板改动漂移）。 */
  const resultPrompt = ref('')
  /** LoRA facts belong to the displayed result, not a pending or failed attempt. */
  const lastLoras = ref<Array<{ id: string; strength: number }>>([])
  const errorMsg    = ref('')
  const samplers    = ref<string[]>([])
  const schedulers  = ref<string[]>([])
  const upscalers   = ref<string[]>([])
  const models      = ref<string[]>([])
  const provider    = ref<'comfy' | 'webui' | ''>('')

  let abortCtrl: AbortController | null = null
  let activeJobId = ''

  function abandonAcceptedJob(jobId: string) {
    if (!jobId) return
    void generationApi.deleteJob(jobId).catch(() => {})
  }

  async function checkStatus(): Promise<boolean> {
    // 应用生成路由统一走 /api/generation/status（含 Comfy 探测与白名单资源检查）。
    // 网关给出明确结论（含 offline）时直接采用，只有请求失败才落到旧 WebUI 探测。
    const generation = await generationApi.getStatus().catch(() => null)
    if (generation) {
      online.value = generation.online === true
      samplers.value = Array.isArray(generation.samplers) ? generation.samplers : []
      schedulers.value = Array.isArray(generation.schedulers) ? generation.schedulers : []
      upscalers.value = Array.isArray(generation.capabilities?.hiresUpscalers) ? generation.capabilities.hiresUpscalers : []
      models.value = generation.checkpoint ? [generation.checkpoint] : []
      checkpoint.value = generation.checkpoint || ''
      // 应用生成路由只允许 WAI v17；它已响应时不得再用任意 WebUI checkpoint
      // 覆盖状态，否则界面所选底模与实际服务端执行会不一致。
      return online.value
    }
    // Comfy 不可用时保留旧 WebUI 状态探测作为兼容状态。
    try {
      const data = parseSDStatus(await mediaStatusApi.getSDStatus())
        online.value = data.online
        samplers.value = data.samplers
        schedulers.value = data.schedulers
        upscalers.value = data.upscalers
        models.value = data.models
        checkpoint.value = data.checkpoint
        if (online.value) return true
    } catch { /* fall through */ }

    try {
      const [modelsRes, samplersRes, schedulersRes] = await Promise.all([
        fetch('/sdapi/v1/sd-models', { cache: 'no-store' }),
        fetch('/sdapi/v1/samplers', { cache: 'no-store' }).catch(() => null),
        fetch('/sdapi/v1/schedulers', { cache: 'no-store' }).catch(() => null),
      ])
      if (!modelsRes.ok) { online.value = false; return false }
      const modelList: unknown = await modelsRes.json()
      online.value = true
      models.value = parseSDOptionList(modelList, ['title', 'model_name', 'name'])
      if (samplersRes?.ok) {
        const list: unknown = await samplersRes.json()
        samplers.value = parseSDOptionList(list)
      }
      if (schedulersRes?.ok) {
        const list: unknown = await schedulersRes.json()
        schedulers.value = parseSDOptionList(list, ['name', 'label'])
      }
      return true
    } catch {
      online.value = false
      return false
    }
  }

  async function generate(params: SDGenerateParams): Promise<string | null> {
    if (generating.value) return null
    generating.value = true
    taskState.value = 'submitting'
    progress.value   = 0
    statusText.value = '正在生成…'
    errorMsg.value   = ''
    // 2026-09-06 体验报告 F2：提交不再清掉上一张成片——旧图在生成期间保持可见，
    // 新图落地时才由下方 revoke+替换接管；失败/取消时旧图从未离开，自然还在。

    abortCtrl = new AbortController()
    const controller = abortCtrl

    try {
      params = JSON.parse(JSON.stringify(params)) as SDGenerateParams
      const { buildTxt2ImgRequest } = await import('@/utils/sdRequest')
      controller.signal.throwIfAborted()
      const { payload } = buildTxt2ImgRequest(params)

      statusText.value = 'SD WebUI 生成中…'

      const loraNames = params.lora ? (Array.isArray(params.lora) ? params.lora : String(params.lora).split(',')) : []
      const loras = loraNames.map(raw => {
        const match = String(raw).replace(/^<lora:/i, '').replace(/>$/, '').split(':')
        const name = match[0].trim()
        const id = name === 'ayachi_nene_v18_wd14' ? 'L_NENE_V18_WD14' : name === 'shiki_natsume_v18_wd14' ? 'L_NAT_V18_WD14' : ''
        const strength = match[1]?.trim() ? Number(match[1]) : params.lora_weight
        return id ? { id, strength: typeof strength === 'number' && Number.isFinite(strength) ? strength : 0.8 } : null
      }).filter((x): x is { id: string; strength: number } => Boolean(x))
      const modelId = String(params.model || '').includes('waiIllustriousSDXL_v170') ? 'waiIllustriousSDXL_v170' : undefined
      const accepted = await generationApi.createJob({
        prompt: payload.prompt, negative: payload.negative_prompt, profile: '',
        ...(modelId ? { modelId } : {}),
        character: params.char || '', loras, width: payload.width, height: payload.height,
        steps: payload.steps, cfg: payload.cfg_scale, seed: payload.seed,
        sampler: payload.sampler_name, scheduler: String(payload.scheduler || params.scheduler || ''),
        hiresFix: Boolean(params.hr_fix), hiresScale: params.hr_scale, hiresUpscaler: params.hr_upscaler,
        hiresSteps: params.hr_second_pass_steps, denoisingStrength: params.denoising_strength,
        faceDetailer: Boolean(params.alwayson_scripts?.ADetailer),
        ...(isLocalStudioHost() ? { adultEnabled: true } : {}),
      }, { signal: controller.signal })
      if (controller.signal.aborted) {
        abandonAcceptedJob(accepted.job.id)
        controller.signal.throwIfAborted()
      }

      provider.value = accepted.job.provider === 'comfy' ? 'comfy' : 'webui'
      activeJobId = accepted.job.id
      let job = accepted.job
      taskState.value = job.status === 'succeeded' ? 'running' : job.status
      const deadline = Date.now() + 20 * 60 * 1000
      const startedAt = Date.now()
      /**
       * 卡死检测阈值（2026-08-30 UX 审计 P0-9）。
       *
       * 真实进度（下方 while 循环消费 job.progress）覆盖「在跑」的可见性；这层
       * 兜底覆盖「进度长时间不动 / WebUI 路径无进度」的死角——按步数与是否开
       * 二阶段粗估耗时上限，超过后在状态文案上挂一句可操作提示（照
       * VideoStudioView 的 2.5× 预估口径）。估计刻意偏保守（2s/步，二阶段按
       * 2.25× 面积折算），宁可少报不可误报。
       *
       * 只提示、**不擅自取消**：对出图而言「再等等其实能出」比「被系统自己
       * 掐掉」的损失小得多，决定权留给用户。
       */
      const baseSteps = Number(params.steps) || 30
      const hiresSteps = params.hr_fix ? (Number(params.hr_second_pass_steps) || 0) * 2.25 : 0
      const estimatedMs = (baseSteps + hiresSteps) * 2000 + 30_000
      const stuckAfterMs = Math.max(120_000, estimatedMs * 2.5)
      let stuckNoted = false
      /**
       * 真实进度消费（2026-08-30 UX 审计 P0-9）。
       *
       * generation.js 的 Comfy 分支复用 anima 服务（createAnimaService），后端
       * 早就把 ComfyUI ws 步骤进度写进 job.progress / progressText / currentNode
       * 并经 publicJob 序列化——此前前端只读 status，把这条已有通道晾在一边
       * （旧注释「job API 不产出真实进度」已过时，属注释与实现矛盾，一并修正）。
       *
       * 消费规则：
       * - 后端给 0–1 数值 → 映射到 0–100 交给进度环；
       * - 后端给 null（WebUI 路径的 publicJob 不带 progress 字段 / Comfy 尚未
       *   收到步骤事件）→ progress 置 null，UI 走 indeterminate 动画，**不做
       *   匀速假增量**——这条诚实纪律保持不变；
       * - 状态文案优先用后端 progressText（含「采样 12/30 · 节点」），无则退回
       *   「引擎 + 已等待秒数」。
       */
      while (Date.now() < deadline) {
        controller.signal.throwIfAborted()
        taskState.value = job.status === 'succeeded' ? 'running' : job.status
        if (job.status === 'failed') throw new Error(job.error || '生成失败')
        if (job.status === 'cancelled') throw new DOMException('cancelled', 'AbortError')
        if (job.status === 'succeeded' && job.resultUrl) break
        await new Promise(resolve => setTimeout(resolve, 700))
        controller.signal.throwIfAborted()
        const state = await generationApi.getJob(job.id, { signal: controller.signal })
        controller.signal.throwIfAborted()
        if (!state.job) throw new Error('生成状态无效')
        job = state.job
        // 后端 publicJob 在 WebUI 路径下不产出 progress 字段（undefined），
        // Comfy 路径排队期也不给——这两类都视为「未知」，交给 indeterminate。
        progress.value = job.status === 'succeeded' ? 100
          : typeof job.progress === 'number' ? Math.round(job.progress * 100)
          : null
        const elapsedMs = Date.now() - startedAt
        if (elapsedMs > stuckAfterMs) stuckNoted = true
        statusText.value = (typeof job.progressText === 'string' && job.progressText
            ? job.progressText
            : (provider.value === 'comfy' ? 'ComfyUI 生成中' : 'SD WebUI 生成中'))
          + ` · 已等待 ${Math.max(0, Math.round(elapsedMs / 1000))}s`
          + (stuckNoted ? ' · 耗时异常，可检查 ComfyUI 是否卡住，必要时取消后重试' : '')
      }
      if (job.status !== 'succeeded' || !job.resultUrl) {
        // A client-side deadline must not leave an accepted job consuming the
        // backend queue. The request may still finish, but its result has no
        // owner after this generation attempt ends.
        abandonAcceptedJob(job.id)
        throw new Error('生成超时')
      }
      const resultResponse = await fetch(job.resultUrl, { cache: 'no-store', signal: controller.signal })
      controller.signal.throwIfAborted()
      if (!resultResponse.ok || !String(resultResponse.headers.get('content-type') || '').startsWith('image/')) throw new Error('生成结果不是图片')
      const blob = await resultResponse.blob()
      // Cancellation/unmount may win after the response or body has resolved.
      // Check before publishing a result or acquiring its object URL.
      controller.signal.throwIfAborted()
      if (!blob.size) throw new Error('生成结果为空')
      const url = URL.createObjectURL(blob)
      // 覆盖前先释放上一张，否则每出一张图泄漏一个 blob URL
      if (resultUrl.value && resultUrl.value !== url) URL.revokeObjectURL(resultUrl.value)
      resultUrl.value  = url
      resultSeed.value = job.metadata?.seed ?? job.seed ?? null
      resultPrompt.value = payload.prompt
      lastLoras.value = loras
      taskState.value = 'succeeded'
      statusText.value = '生成完成'
      return url
    } catch (e) {
      if (isAbortError(e) || controller.signal.aborted) { taskState.value = 'cancelled'; statusText.value = '已停止'; return null }
      taskState.value = 'failed'
      errorMsg.value   = errorMessage(e)
      statusText.value = '生成失败'
      return null
    } finally {
      generating.value = false
      progress.value = 0
      abortCtrl = null
      activeJobId = ''
    }
  }

  function cancel() {
    if (!generating.value) return
    taskState.value = 'cancelling'
    abortCtrl?.abort()
    if (activeJobId) {
      abandonAcceptedJob(activeJobId)
    }
    // Cancellation is owned by the application job route. Do not issue a
    // global WebUI interrupt for a Comfy job.
  }

  function clearResult() {
    if (!generating.value) taskState.value = 'idle'
    if (resultUrl.value) { URL.revokeObjectURL(resultUrl.value); resultUrl.value = '' }
    lastLoras.value = []
    resultSeed.value = null; resultPrompt.value = ''; errorMsg.value = ''; statusText.value = ''; progress.value = 0
  }

  /**
   * 领养一张外部恢复的结果（2026-09-06 体验报告 F2 临时成片找回）：
   * 把 blob URL 与它的 seed/prompt 挂回会话，舞台与「出视频/加入分镜」随即可用。
   */
  function adoptResult(url: string, seed: number | null, prompt: string) {
    taskState.value = 'succeeded'
    if (resultUrl.value && resultUrl.value !== url) URL.revokeObjectURL(resultUrl.value)
    resultUrl.value = url
    resultSeed.value = seed
    resultPrompt.value = prompt
    // Restored images do not inherit LoRAs from an unrelated local result.
    lastLoras.value = []
    errorMsg.value = ''
    statusText.value = '已找回上次未入册的成片'
  }

  /** 组件卸载时收尾：取消 in-flight 任务并释放 blob，防止出图途中离开页面泄漏。 */
  function dispose() {
    cancel()
    abortCtrl = null
    if (resultUrl.value) { URL.revokeObjectURL(resultUrl.value); resultUrl.value = '' }
  }

  // 在组件上下文里自动挂载；被普通函数调用时（如测试）跳过
  if (getCurrentInstance()) onUnmounted(dispose)

  return {
    taskState: readonly(taskState), online: readonly(online), checkpoint: readonly(checkpoint),
    generating: readonly(generating),
    progress: readonly(progress), statusText: readonly(statusText),
    resultUrl: readonly(resultUrl), resultSeed: readonly(resultSeed), resultPrompt: readonly(resultPrompt),
    errorMsg: readonly(errorMsg), samplers: readonly(samplers),
    schedulers: readonly(schedulers), upscalers: readonly(upscalers),
    models: readonly(models), provider: readonly(provider),
    lastLoras: readonly(lastLoras),
    checkStatus, generate, cancel, clearResult, adoptResult, dispose,
  }
}

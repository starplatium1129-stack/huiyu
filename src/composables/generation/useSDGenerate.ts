import { ref, readonly, onUnmounted, getCurrentInstance } from 'vue'
import type { SDGenerateParams } from '@/utils/sdRequest'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { hasRuntimeTasks, runtimeRequestKey } from '@/api/runtimeTaskAuthority'
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
  const resultTaskId = ref('')
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
  let durableAttempt = false, durableKey = ''

  function abandonAcceptedJob(jobId: string) {
    if (!jobId) return
    void import('@/platform/web/generationSession').then(api => api.cancelWebGeneration(jobId)).catch(() => {})
  }

  async function checkStatus(): Promise<boolean> {
    const { readWebGenerationStatus } = await import('@/platform/web/generationSession')
    const value = await readWebGenerationStatus()
    online.value = value.online
    if (value.checkpoint !== undefined) checkpoint.value = value.checkpoint
    if (value.models) models.value = value.models
    if (value.samplers) samplers.value = value.samplers
    if (value.schedulers) schedulers.value = value.schedulers
    if (value.upscalers) upscalers.value = value.upscalers
    return value.online
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
    durableAttempt = hasRuntimeTasks(); durableKey = ''

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
      const jobInput = {
        prompt: payload.prompt, negative: payload.negative_prompt, profile: '',
        ...(modelId ? { modelId } : {}),
        character: params.char || '', loras, width: payload.width, height: payload.height,
        steps: payload.steps, cfg: payload.cfg_scale, seed: payload.seed,
        sampler: payload.sampler_name, scheduler: String(payload.scheduler || params.scheduler || ''),
        hiresFix: Boolean(params.hr_fix), hiresScale: params.hr_scale, hiresUpscaler: params.hr_upscaler,
        hiresSteps: params.hr_second_pass_steps, denoisingStrength: params.denoising_strength,
        faceDetailer: Boolean(params.alwayson_scripts?.ADetailer),
        ...(isLocalStudioHost() ? { adultEnabled: true } : {}),
      }
      if (durableAttempt) {
        durableKey = runtimeRequestKey('generation', jobInput)
        const { runRuntimeSd } = await import('./runtimeImageSession')
        const url = await runRuntimeSd(jobInput, durableKey, controller.signal,
          { taskState, statusText, progress, provider, resultUrl, resultSeed, resultTaskId, resultPrompt }, params.runtimeContext)
        lastLoras.value = loras
        return url
      }
      const { runWebGeneration } = await import('@/platform/web/generationSession')
      const { blob, seed } = await runWebGeneration(jobInput, {
        signal: controller.signal, steps: params.steps, hires: params.hr_fix, hiresSteps: params.hr_second_pass_steps,
        accepted(id, selectedProvider) { activeJobId = id; provider.value = selectedProvider },
        progress(value) { taskState.value = value.status; if (value.progress !== undefined) progress.value = value.progress; if (value.text !== undefined) statusText.value = value.text },
      })
      controller.signal.throwIfAborted()
      const url = URL.createObjectURL(blob)
      // 覆盖前先释放上一张，否则每出一张图泄漏一个 blob URL
      if (resultUrl.value && resultUrl.value !== url) URL.revokeObjectURL(resultUrl.value)
      resultUrl.value  = url
      resultTaskId.value = ''
      resultSeed.value = seed
      resultPrompt.value = payload.prompt
      lastLoras.value = loras
      taskState.value = 'succeeded'
      statusText.value = '生成完成'
      return url
    } catch (e) {
      if (isAbortError(e) || controller.signal.aborted) { taskState.value = 'cancelled'; statusText.value = '已停止'; return null }
      taskState.value = durableAttempt ? 'unknown' : 'failed'
      errorMsg.value   = errorMessage(e)
      statusText.value = durableAttempt ? '请在任务中心查看已接收任务' : '生成失败'
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
    if (durableAttempt) { if (durableKey) { const key = durableKey; void import('@/api/runtimeTasks').then(api => api.cancelRuntimeTaskKey(key)).catch(() => { errorMsg.value = '取消尚未确认，请到任务中心核对' }) } return }
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
    resultTaskId.value = ''
    resultSeed.value = null; resultPrompt.value = ''; errorMsg.value = ''; statusText.value = ''; progress.value = 0
  }

  /**
   * 领养一张外部恢复的结果（2026-09-06 体验报告 F2 临时成片找回）：
   * 把 blob URL 与它的 seed/prompt 挂回会话，舞台与「出视频/加入分镜」随即可用。
   */
  function adoptResult(url: string, seed: number | null, prompt: string, taskId = '') {
    taskState.value = 'succeeded'
    if (resultUrl.value && resultUrl.value !== url) URL.revokeObjectURL(resultUrl.value)
    resultUrl.value = url
    resultSeed.value = seed
    resultPrompt.value = prompt
    resultTaskId.value = taskId
    // Restored images do not inherit LoRAs from an unrelated local result.
    lastLoras.value = []
    errorMsg.value = ''
    statusText.value = '已找回上次未入册的成片'
  }

  /** 组件卸载时收尾：取消 in-flight 任务并释放 blob，防止出图途中离开页面泄漏。 */
  function dispose() {
    if (durableAttempt) abortCtrl?.abort()
    else cancel()
    abortCtrl = null
    if (resultUrl.value) { URL.revokeObjectURL(resultUrl.value); resultUrl.value = '' }
  }

  // 在组件上下文里自动挂载；被普通函数调用时（如测试）跳过
  if (getCurrentInstance()) onUnmounted(dispose)

  return {
    taskState: readonly(taskState), online: readonly(online), checkpoint: readonly(checkpoint),
    generating: readonly(generating),
    progress: readonly(progress), statusText: readonly(statusText),
    resultUrl: readonly(resultUrl), resultSeed: readonly(resultSeed), resultPrompt: readonly(resultPrompt), resultTaskId: readonly(resultTaskId),
    errorMsg: readonly(errorMsg), samplers: readonly(samplers),
    schedulers: readonly(schedulers), upscalers: readonly(upscalers),
    models: readonly(models), provider: readonly(provider),
    lastLoras: readonly(lastLoras),
    checkStatus, generate, cancel, clearResult, adoptResult, dispose,
  }
}

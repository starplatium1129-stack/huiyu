import { ref, readonly, onUnmounted, getCurrentInstance } from 'vue'
import type { SDGenerateParams } from '@/utils/sdRequest'
import { hasRuntimeTasks } from '@/api/runtimeTaskAuthority'
import type { TaskRecord } from '../../../types/tasks'
import type { RuntimeSdAttempt } from './legacySdTaskSession'
import type { AnimaResultContext } from '@/types/anima'
import { AcceptedTaskTerminalError } from '@/api/acceptedTaskOutcome'
export type { SDGenerateParams } from '@/utils/sdRequest'

export interface LegacySdObserveOptions {
  /** Existing FIFO intent; batch plans continue to own their own request keys. */
  attempt?: RuntimeSdAttempt
  requestKey?: string
  onAccepted?: (task: TaskRecord) => void | Promise<void>
  onAcceptedId?: (id: string) => void | Promise<void>
  resumeId?: string
  onError?: (error: unknown) => void
  signal?: AbortSignal
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useLegacySdTasks() {
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
  const resultContext = ref<AnimaResultContext | null>(null)
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
  let queueAttempt: RuntimeSdAttempt | undefined
  let requestSerial = 0, cancelRequested = false

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
  async function observe(params: SDGenerateParams, options: LegacySdObserveOptions = {}): Promise<string | null> {
    if (generating.value) {
      // Concurrent observers keep the original persisted task identity.
      return null
    }
    if (!options.attempt?.key && !options.requestKey && !options.resumeId) {
      const error = new Error('SD 新生成已退役；只能核对已有任务编号。')
      errorMsg.value = error.message; taskState.value = 'failed'; statusText.value = error.message
      options.onError?.(error)
      return null
    }
    generating.value = true
    taskState.value = 'running'
    progress.value   = null
    statusText.value = '正在核对旧任务…'
    errorMsg.value   = ''
    // 观察旧任务时不清掉上一张成片；旧图在等待期间保持可见，
    // 新图落地时才由下方 revoke+替换接管；失败/取消时旧图从未离开，自然还在。

    abortCtrl = new AbortController()
    const controller = abortCtrl
    requestSerial += 1
    cancelRequested = false
    const submitted = Boolean(options.attempt?.key || options.requestKey || options.resumeId)
    let accepted = false
    const stopObservation = () => controller.abort()
    options.signal?.addEventListener('abort', stopObservation, { once: true })
    if (options.signal?.aborted) controller.abort()
    durableAttempt = hasRuntimeTasks(); durableKey = options.attempt?.key || options.requestKey || ''
    queueAttempt = options.attempt

    try {
      params = JSON.parse(JSON.stringify(params)) as SDGenerateParams
      if (durableAttempt) {
        if (!durableKey) throw new Error('旧 SD 任务缺少原请求编号，不能创建新任务。')
        const { observeRuntimeSd } = await import('./legacySdTaskSession')
        const url = await observeRuntimeSd(durableKey, controller.signal,
          { taskState, statusText, progress, provider, resultUrl, resultSeed, resultTaskId, resultPrompt, resultContext },
          async task => { accepted = true; await options.onAccepted?.(task) }, options.attempt)
        lastLoras.value = resultContext.value?.history?.loras?.map(lora => ({ ...lora })) ?? []
        return url
      }
      if (!options.resumeId) throw new Error('旧浏览器任务没有接收编号，请在任务中心核对；不会重新提交。')
      activeJobId = options.resumeId
      // Frozen legacy parameters supply result facts, never a new request.
      const [{ buildTxt2ImgRequest }, { buildRuntimeSdInput }, { isLocalStudioHost }] = await Promise.all([
        import('@/utils/sdRequest'), import('@/utils/sdRuntimeRequest'), import('@/utils/runtimeEnvironment'),
      ])
      const { payload } = buildTxt2ImgRequest(params)
      const loras = buildRuntimeSdInput(params, payload, isLocalStudioHost()).loras
      const { observeWebGeneration } = await import('@/platform/web/generationSession')
      const { blob, seed } = await observeWebGeneration(options.resumeId, {
        signal: controller.signal, steps: params.steps, hires: params.hr_fix, hiresSteps: params.hr_second_pass_steps,
        async accepted(id, selectedProvider) { activeJobId = id; provider.value = selectedProvider; await options.onAcceptedId?.(id) },
        progress(value) { taskState.value = value.status; if (value.progress !== undefined) progress.value = value.progress; if (value.text !== undefined) statusText.value = value.text },
      })
      controller.signal.throwIfAborted()
      const url = URL.createObjectURL(blob)
      // 覆盖前先释放上一张，否则每出一张图泄漏一个 blob URL
      if (resultUrl.value && resultUrl.value !== url) URL.revokeObjectURL(resultUrl.value)
      resultUrl.value  = url
      resultTaskId.value = ''
      resultContext.value = null
      resultSeed.value = seed
      resultPrompt.value = payload.prompt
      lastLoras.value = loras
      taskState.value = 'succeeded'
      statusText.value = '生成完成'
      return url
    } catch (e) {
      options.onError?.(e)
      if (durableAttempt) {
        const { runtimeSdFailure } = await import('./legacySdTaskSession')
        const failure = runtimeSdFailure(e, controller.signal.aborted, submitted, accepted, cancelRequested)
        taskState.value = failure.state; statusText.value = failure.message; errorMsg.value = failure.error
        return null
      }
      if (isAbortError(e) || controller.signal.aborted) {
        taskState.value = cancelRequested ? 'cancelled' : 'unknown'
        statusText.value = cancelRequested ? '已停止' : '已停止查看，原任务仍由服务端管理'
        return null
      }
      taskState.value = e instanceof AcceptedTaskTerminalError ? e.status : 'unknown'
      errorMsg.value = e instanceof AcceptedTaskTerminalError && e.status === 'cancelled' ? '' : errorMessage(e)
      statusText.value = e instanceof AcceptedTaskTerminalError ? (e.status === 'cancelled' ? '任务已取消' : '任务失败') : '原任务状态尚未确认，请继续核对'
      return null
    } finally {
      options.signal?.removeEventListener('abort', stopObservation)
      generating.value = false
      progress.value = 0
      abortCtrl = null
      activeJobId = ''
    }
  }

  function cancel() {
    if (!generating.value) return
    cancelRequested = true
    taskState.value = 'cancelling'
    abortCtrl?.abort()
    if (durableAttempt) {
      if (durableKey) {
        const key = durableKey
        const serial = requestSerial
        const cancellation = queueAttempt ? queueAttempt.cancel() : import('@/api/runtimeTasks').then(api => api.cancelRuntimeTaskKey(key))
        void cancellation.then(task => {
          if (!task || serial !== requestSerial || !task.upstreamSettled) return
          taskState.value = task.status
          statusText.value = task.status === 'cancelled' ? '任务已取消' : '任务已经结束，请在收件箱核对结果'
        }).catch(() => { if (serial === requestSerial) errorMsg.value = '取消尚未确认，请到任务中心核对' })
      }
      return
    }
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
    resultContext.value = null
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
    resultContext.value = null
    // Restored images do not inherit LoRAs from an unrelated local result.
    lastLoras.value = []
    errorMsg.value = ''
    statusText.value = '已找回上次未入册的成片'
  }

  /** Unmount stops observation and releases owned URLs; explicit cancel owns DELETE. */
  function dispose() {
    // Persisted batch plans own their accepted IDs; page disposal releases only observation.
    abortCtrl?.abort()
    abortCtrl = null
    if (resultUrl.value) { URL.revokeObjectURL(resultUrl.value); resultUrl.value = '' }
  }

  // 在组件上下文里自动挂载；被普通函数调用时（如测试）跳过
  if (getCurrentInstance()) onUnmounted(dispose)

  return {
    taskState: readonly(taskState), online: readonly(online), checkpoint: readonly(checkpoint),
    generating: readonly(generating),
    progress: readonly(progress), statusText: readonly(statusText),
    resultUrl: readonly(resultUrl), resultSeed: readonly(resultSeed), resultPrompt: readonly(resultPrompt), resultTaskId: readonly(resultTaskId), resultContext: readonly(resultContext),
    errorMsg: readonly(errorMsg), samplers: readonly(samplers),
    schedulers: readonly(schedulers), upscalers: readonly(upscalers),
    models: readonly(models), provider: readonly(provider),
    lastLoras: readonly(lastLoras),
    checkStatus, observe, cancel, clearResult, adoptResult, dispose,
  }
}

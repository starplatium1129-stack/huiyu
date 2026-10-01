import type { Ref } from 'vue'
import { submitRuntimeTask, waitForRuntimeTask, fetchRuntimeResult, runtimeResultPath, taskMessage, type TaskRecord } from '@/api/runtimeTasks'
import type { AnimaGenerationState, AnimaResult, AnimaResultContext } from '@/types/anima'
import { ApiClientError } from '@/api/client'
import { AcceptedTaskTerminalError } from '@/api/acceptedTaskOutcome'
import { classifySDError } from '@/utils/sdError'

export function imageFailurePatch(error: unknown, statusText: string) {
  const report = classifySDError(error, 'comfy')
  return { phase: 'failed' as const, statusText,
    errorMsg: report.kind === 'cancelled' ? report.message : `${report.title}：${report.message}`, errorReport: report }
}

export function runtimeAnimaFailure(error: unknown, stopped: boolean, accepted: boolean): Partial<AnimaGenerationState> {
  if (error instanceof AcceptedTaskTerminalError && error.status === 'cancelled') return { phase: 'cancelled', statusText: '任务已取消', errorMsg: '', errorReport: null }
  if (stopped) return { phase: 'cancelled', statusText: '已停止提交', errorMsg: '', errorReport: null }
  if (error instanceof ApiClientError && error.kind === 'aborted') return {}
  const definitive = error instanceof AcceptedTaskTerminalError || !accepted && error instanceof ApiClientError && error.kind === 'http' && error.status < 500
  return { ...imageFailurePatch(error, definitive ? '生成失败' : '任务状态尚未确认，请到任务中心核对'),
    ...(!definitive ? { backendStatus: 'unknown' } : {}) }
}

/** Display projection of one runtime attempt; the runtime's task state stays authoritative. */
export function runtimeSdFailure(error: unknown, stopped: boolean, submitted: boolean, accepted: boolean, cancelRequested: boolean) {
  if (error instanceof AcceptedTaskTerminalError) return { state: error.status,
    message: error.status === 'cancelled' ? '任务已取消' : '生成失败', error: error.status === 'failed' ? error.message : '' }
  if (stopped || error instanceof Error && error.name === 'AbortError') {
    const owned = submitted || accepted
    return { state: owned ? cancelRequested ? 'cancelling' : 'unknown' : 'cancelled',
      message: owned ? cancelRequested ? '已请求取消，请在任务中心核对' : '已停止查看，任务仍由运行时管理' : '已停止', error: '' }
  }
  const rejected = !accepted && error instanceof ApiClientError && error.kind === 'http' && error.status < 500
  return { state: rejected ? 'failed' : 'unknown', message: rejected ? '生成失败' : '请在任务中心核对接收与结果状态', error: error instanceof Error ? error.message : String(error) }
}

/** Queue-owned intent identity; task execution remains owned by the runtime. */
export interface RuntimeSdAttempt {
  key: string
  task?: TaskRecord
  rejected(): Promise<void>
  cancel(): Promise<void>
}

async function image(kind: 'generation' | 'anima' | 'creative', input: Record<string, unknown>, key: string,
  signal: AbortSignal, update: (task: TaskRecord) => void, context?: Record<string, unknown>,
  onAccepted?: (task: TaskRecord) => void | Promise<void>, onSubmitting?: () => void, attempt?: RuntimeSdAttempt) {
  signal.throwIfAborted()
  let accepted = attempt?.task
  if (!accepted) {
    try { accepted = await submitRuntimeTask(kind, input, key, context, { signal, onSubmitting }) }
    catch (error) {
      // Only a definitive POST rejection releases a queue attempt; later
      // observation or archive failures never permit another submission.
      if (error instanceof ApiClientError && error.kind === 'http' && error.status < 500) await attempt?.rejected()
      throw error
    }
  }
  await onAccepted?.(accepted)
  signal.throwIfAborted()
  const task = await waitForRuntimeTask(accepted.taskId, signal, update)
  const blob = await fetchRuntimeResult(runtimeResultPath(task), signal)
  signal.throwIfAborted()
  return { task, blob }
}
export async function runRuntimeSd(input: Record<string, unknown>, key: string, signal: AbortSignal,
  fields: { taskState: Ref<string>; statusText: Ref<string>; progress: Ref<number | null>; provider: Ref<'comfy' | 'webui' | ''>;
    resultUrl: Ref<string>; resultSeed: Ref<number | null>; resultTaskId: Ref<string>; resultPrompt: Ref<string>; resultContext: Ref<AnimaResultContext | null> }, context?: Record<string, unknown>,
  onAccepted?: (task: TaskRecord) => void | Promise<void>, onSubmitting?: () => void, attempt?: RuntimeSdAttempt) {
  const { task, blob } = await image('generation', input, key, signal, value => {
    fields.taskState.value = value.recoveryState === 'normal' ? value.status : value.recoveryState; fields.statusText.value = taskMessage(value); fields.progress.value = null
    fields.provider.value = value.provider === 'webui' ? 'webui' : 'comfy'
  }, context, onAccepted, onSubmitting, attempt)
  const { runtimeTaskRecipe, runtimeTaskResultContext } = await import('@/utils/runtimeTaskResult')
  signal.throwIfAborted()
  const recipe = runtimeTaskRecipe(task), resultContext = runtimeTaskResultContext(task)
  const url = URL.createObjectURL(blob)
  if (fields.resultUrl.value) URL.revokeObjectURL(fields.resultUrl.value)
  fields.resultUrl.value = url; fields.resultSeed.value = recipe.seed ?? null
  fields.resultTaskId.value = task.taskId; fields.resultPrompt.value = recipe.prompt ?? ''
  fields.resultContext.value = resultContext
  fields.taskState.value = 'succeeded'; fields.statusText.value = '生成完成 · 已保存在收件箱'
  return url
}
export async function runRuntimeAnima(options: {
  input: Record<string, unknown>; key: string; signal: AbortSignal; family: 'anima' | 'krea2';
  context: AnimaResultContext | null; state: Ref<AnimaGenerationState>; isCurrent(): boolean;
  onAccepted(): void;
  discardStashed(): void; onResult(result: AnimaResult): void;
}) {
  const { task, blob } = await image(options.family === 'krea2' ? 'creative' : 'anima', options.input, options.key, options.signal, value => {
    options.state.value = { ...options.state.value, phase: value.status === 'cancelling' ? 'cancelling' : 'running', backendStatus: value.recoveryState === 'normal' ? value.status : value.recoveryState,
      progress: null, progressText: taskMessage(value), statusText: taskMessage(value) }
  }, options.context as Record<string, unknown> | undefined, options.onAccepted)
  const { runtimeImageMetadata, runtimeTaskResultContext } = await import('@/utils/runtimeTaskResult')
  if (!options.isCurrent()) return
  const metadata = runtimeImageMetadata(task)
  const context = runtimeTaskResultContext(task)
  const result = { url: URL.createObjectURL(blob), blob, metadata }
  if (options.state.value.result) URL.revokeObjectURL(options.state.value.result.url)
  options.discardStashed()
  options.state.value = { ...options.state.value, result, job: metadata, resultContext: context, phase: 'succeeded', progress: 1,
    statusText: '生成完成 · 已保存在收件箱', progressText: '生成完成', errorMsg: '', errorReport: null }
  options.onResult(result)
}

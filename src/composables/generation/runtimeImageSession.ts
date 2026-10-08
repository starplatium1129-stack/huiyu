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
  // Epoch changes stop observation, not the runtime-owned task or the creator's next action.
  if (error instanceof ApiClientError && error.kind === 'aborted' && error.code !== 'RUNTIME_EPOCH_CHANGED') return {}
  const definitive = error instanceof AcceptedTaskTerminalError || !accepted && error instanceof ApiClientError && error.kind === 'http' && error.status < 500
  return { ...imageFailurePatch(error, definitive ? '生成失败' : '任务状态尚未确认，请到任务中心核对'),
    ...(!definitive ? { backendStatus: 'unknown' } : {}) }
}

async function image(kind: 'anima' | 'creative', input: Record<string, unknown>, key: string,
  signal: AbortSignal, update: (task: TaskRecord) => void, context?: Record<string, unknown>,
  onAccepted?: (task: TaskRecord) => void | Promise<void>, onSubmitting?: () => void) {
  signal.throwIfAborted()
  const accepted = await submitRuntimeTask(kind, input, key, context, { signal, onSubmitting })
  await onAccepted?.(accepted)
  signal.throwIfAborted()
  const task = await waitForRuntimeTask(accepted.taskId, signal, update)
  const blob = await fetchRuntimeResult(runtimeResultPath(task), signal)
  signal.throwIfAborted()
  return { task, blob }
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

import type { Ref } from 'vue'
import { getRuntimeTaskByKey, submitRuntimeTask, waitForRuntimeTask, fetchRuntimeResult, runtimeResultPath, taskMessage, type TaskSummary } from '@/api/runtimeTasks'
import type { AnimaGenerationState, AnimaResult, AnimaResultContext } from '@/types/anima'
import { classifySDError, type SDBackend } from '@/utils/sdError'

export function imageFailurePatch(error: unknown, statusText: string, provider: SDBackend) {
  const report = classifySDError(error, provider)
  return { phase: 'failed' as const, statusText,
    errorMsg: report.kind === 'cancelled' ? report.message : `${report.title}：${report.message}`, errorReport: report }
}

async function image(kind: 'anima' | 'creative', input: Record<string, unknown>, key: string,
  signal: AbortSignal, update: (task: TaskSummary) => void, context: Record<string, unknown> | undefined,
  onSubmitting: () => void, resume = false) {
  signal.throwIfAborted()
  const accepted = resume ? await getRuntimeTaskByKey(key, signal) : await submitRuntimeTask(kind, input, key, context, { signal, onSubmitting })
  if (!accepted) throw new Error('原请求接收状态尚未确认，已保留身份；不会重复生成')
  signal.throwIfAborted()
  const task = await waitForRuntimeTask(accepted.taskId, signal, update)
  const blob = await fetchRuntimeResult(runtimeResultPath(task), signal, task)
  signal.throwIfAborted()
  return { task, blob }
}
export async function runRuntimeAnima(options: {
  input: Record<string, unknown>; key: string; resume: boolean; signal: AbortSignal; family: 'anima' | 'krea2';
  context: AnimaResultContext | null; state: Ref<AnimaGenerationState>; isCurrent(): boolean;
  onSubmitting(): void;
  discardStashed(): void; onResult(result: AnimaResult): Promise<void>;
}) {
  const { task, blob } = await image(options.family === 'krea2' ? 'creative' : 'anima', options.input, options.key, options.signal, value => {
    if (!options.isCurrent()) return
    options.state.value = { ...options.state.value, phase: value.status === 'cancelling' ? 'cancelling' : 'running', backendStatus: value.recoveryState === 'normal' ? value.status : value.recoveryState,
      progress: null, progressText: taskMessage(value), statusText: taskMessage(value) }
  }, options.context as Record<string, unknown> | undefined, options.onSubmitting, options.resume)
  const { runtimeImageMetadata, runtimeTaskResultContext } = await import('@/utils/runtimeTaskResult')
  if (!options.isCurrent()) return
  const metadata = runtimeImageMetadata(task)
  const context = runtimeTaskResultContext(task)
  const result = { url: URL.createObjectURL(blob), blob, metadata }
  if (options.state.value.result) URL.revokeObjectURL(options.state.value.result.url)
  options.discardStashed()
  options.state.value = { ...options.state.value, result, job: metadata, resultContext: context, phase: 'succeeded', progress: 1,
    statusText: '生成完成 · 已保存在收件箱', progressText: '生成完成', errorMsg: '', errorReport: null }
  await options.onResult(result)
}

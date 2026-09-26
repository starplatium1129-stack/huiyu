import type { Ref } from 'vue'
import { submitRuntimeTask, waitForRuntimeTask, fetchRuntimeResult, runtimeResultPath, taskMessage, type TaskRecord } from '@/api/runtimeTasks'
import type { AnimaGenerationState, AnimaResult, AnimaResultContext } from '@/types/anima'
import type { AnimaPublicJob, AnimaRequest } from './animaSessionContract'

async function image(kind: 'generation' | 'anima' | 'creative', input: Record<string, unknown>, key: string,
  signal: AbortSignal, update: (task: TaskRecord) => void, context?: Record<string, unknown>) {
  const accepted = await submitRuntimeTask(kind, input, key, context)
  signal.throwIfAborted()
  const task = await waitForRuntimeTask(accepted.taskId, signal, update)
  const blob = await fetchRuntimeResult(runtimeResultPath(task), signal)
  signal.throwIfAborted()
  return { task, blob }
}
export async function runRuntimeSd(input: Record<string, unknown>, key: string, signal: AbortSignal,
  fields: { taskState: Ref<string>; statusText: Ref<string>; progress: Ref<number | null>; provider: Ref<'comfy' | 'webui' | ''>;
    resultUrl: Ref<string>; resultSeed: Ref<number | null>; resultTaskId: Ref<string>; resultPrompt: Ref<string> }, context?: Record<string, unknown>) {
  const { task, blob } = await image('generation', input, key, signal, value => {
    fields.taskState.value = value.status; fields.statusText.value = taskMessage(value); fields.progress.value = null
    fields.provider.value = value.provider === 'webui' ? 'webui' : 'comfy'
  }, context)
  signal.throwIfAborted()
  const url = URL.createObjectURL(blob)
  if (fields.resultUrl.value) URL.revokeObjectURL(fields.resultUrl.value)
  fields.resultUrl.value = url; fields.resultSeed.value = Number(task.metadata.seed ?? task.input.seed) || 0
  fields.resultTaskId.value = task.taskId; fields.resultPrompt.value = String(input.prompt || '')
  fields.taskState.value = 'succeeded'; fields.statusText.value = '生成完成 · 已保存在收件箱'
  return url
}
export async function runRuntimeAnima(options: {
  input: Record<string, unknown>; key: string; signal: AbortSignal; family: 'anima' | 'krea2'; request: AnimaRequest;
  context: AnimaResultContext | null; state: Ref<AnimaGenerationState>; isCurrent(): boolean;
  metadata(job: AnimaPublicJob): AnimaResult['metadata']; discardStashed(): void; onResult(result: AnimaResult): void;
}) {
  const { task, blob } = await image(options.family === 'krea2' ? 'creative' : 'anima', options.input, options.key, options.signal, value => {
    options.state.value = { ...options.state.value, phase: value.status === 'cancelling' ? 'cancelling' : 'running', backendStatus: value.status,
      progress: null, progressText: taskMessage(value), statusText: taskMessage(value) }
  }, options.context as Record<string, unknown> | undefined)
  if (!options.isCurrent()) return
  const metadata = options.metadata({ id: task.taskId, status: 'succeeded', seed: Number(task.input.seed) || 0,
    resultAvailable: true, resultUrl: runtimeResultPath(task), error: null, code: null, metadata: task.metadata as unknown as AnimaResult['metadata'] })
  const result = { url: URL.createObjectURL(blob), blob, metadata }
  if (options.state.value.result) URL.revokeObjectURL(options.state.value.result.url)
  options.discardStashed()
  options.state.value = { ...options.state.value, result, job: metadata, resultContext: options.context, phase: 'succeeded', progress: 1,
    statusText: '生成完成 · 已保存在收件箱', progressText: '生成完成', errorMsg: '', errorReport: null }
  options.onResult(result)
}

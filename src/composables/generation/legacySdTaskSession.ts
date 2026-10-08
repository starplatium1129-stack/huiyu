import type { Ref } from 'vue'
import { getRuntimeTaskByKey, waitForRuntimeTask, fetchRuntimeResult, runtimeResultPath, taskMessage, type TaskRecord } from '@/api/runtimeTasks'
import type { AnimaResultContext } from '@/types/anima'
import { ApiClientError } from '@/api/client'
import { AcceptedTaskTerminalError } from '@/api/acceptedTaskOutcome'

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

export interface RuntimeSdAttempt {
  key: string
  task?: TaskRecord
  cancel(): Promise<void>
}

/** Observe only a persisted request identity. This module never submits a task. */
export async function observeRuntimeSd(key: string, signal: AbortSignal,
  fields: { taskState: Ref<string>; statusText: Ref<string>; progress: Ref<number | null>; provider: Ref<'comfy' | 'webui' | ''>;
    resultUrl: Ref<string>; resultSeed: Ref<number | null>; resultTaskId: Ref<string>; resultPrompt: Ref<string>; resultContext: Ref<AnimaResultContext | null> },
  onAccepted?: (task: TaskRecord) => void | Promise<void>, attempt?: RuntimeSdAttempt) {
  signal.throwIfAborted()
  const accepted = attempt?.task ?? await getRuntimeTaskByKey(key, signal)
  if (!accepted) throw new Error('原请求接收状态尚未确认；保留原编号核对，不会重新提交。')
  await onAccepted?.(accepted)
  signal.throwIfAborted()
  const task = await waitForRuntimeTask(accepted.taskId, signal, value => {
    fields.taskState.value = value.recoveryState === 'normal' ? value.status : value.recoveryState
    fields.statusText.value = taskMessage(value); fields.progress.value = null
    fields.provider.value = value.provider === 'webui' ? 'webui' : 'comfy'
  })
  const blob = await fetchRuntimeResult(runtimeResultPath(task), signal)
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

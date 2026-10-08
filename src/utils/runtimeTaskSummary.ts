import type { TaskRecord, TaskSummary } from '../../types/tasks'

export function summarizeTask(task: TaskRecord | TaskSummary): TaskSummary {
  const { input: _input, inputMediaRefs: _media, metadata, checkpoint, requestFingerprint: _fingerprint,
    providerFingerprint: _provider, ...summary } = task as TaskRecord & TaskSummary
  const context = metadata?.context as Record<string, unknown> | undefined
  return {
    ...summary,
    sourceBatchId: summary.sourceBatchId ?? (typeof context?.retriedTaskId === 'string' && context.retriedTaskId
      && Number.isSafeInteger(context.stepIndex) && Number(context.stepIndex) >= 0 ? context.retriedTaskId : null),
    canConcat: summary.canConcat ?? (task.kind === 'batch' && task.status === 'succeeded' && task.resultRefs.length > 1
      && Array.isArray(checkpoint?.shots) && !task.resultRefs.some(result => result.index === (checkpoint.shots as unknown[]).length)),
  }
}

import { getRuntimeTaskByKey, cancelRuntimeTaskKey, type TaskRecord } from '@/api/runtimeTasks'
import type { SDQueueJob } from '@/composables/generation/useSDQueue'
import type { RuntimeSdAttempt } from '@/composables/generation/runtimeImageSession'

type Checkpoint = () => Promise<void>

/** Loaded only when an existing FIFO intent is submitted, reconciled or cancelled. */
export async function cancelPendingSdAttempt(job: SDQueueJob, save: Checkpoint): Promise<void> {
  const attempt = job.attempt
  if (!attempt) return
  attempt.cancelRequested = true
  await save()
  const task = await cancelRuntimeTaskKey(attempt.key)
  // Another acknowledged cancellation may already have allowed an explicit
  // retry. A late receipt for the old key cannot erase the replacement attempt.
  if (job.attempt?.key !== attempt.key) return
  // A null receipt still acknowledges a durable pre-acceptance cancellation
  // fence. It is now safe for an explicit later retry to use a new identity.
  if (!task || (task.upstreamSettled && ['failed', 'cancelled'].includes(task.status))) delete job.attempt
  else attempt.cancelRequested = false
  await save()
}

export async function removePendingSdJob(job: SDQueueJob, save: Checkpoint): Promise<void> {
  job.removeRequested = true
  await save()
  if (job.attempt?.submitted || job.attempt?.cancelRequested) await cancelRuntimeTaskKey(job.attempt.key)
  // The caller removes the row only after the cancellation intent is accepted.
  // A lost receipt leaves this marker available to replay the same DELETE.
}

export async function preparePendingSdAttempt(job: SDQueueJob, save: Checkpoint): Promise<RuntimeSdAttempt> {
  if (job.removeRequested) throw new Error('这项任务正在移出队列，请重试移出')
  if (job.attempt?.cancelRequested) await cancelPendingSdAttempt(job, save)
  let task: TaskRecord | undefined
  if (job.attempt?.submitted) {
    const found = await getRuntimeTaskByKey(job.attempt.key)
    if (!found) throw new Error('上次提交尚未确认，已暂停；请先查询或移出这项任务，不会重复生成')
    if (found.upstreamSettled && ['failed', 'cancelled'].includes(found.status)) delete job.attempt
    else task = found
  }
  job.attempt ||= { key: crypto.randomUUID(), submitted: false }
  const attempt = job.attempt
  if (!task) {
    attempt.submitted = true
    try { await save() }
    catch (error) { attempt.submitted = false; throw error } // This invocation never reached POST.
  }
  return {
    key: attempt.key, task,
    async rejected() { attempt.submitted = false; await save() },
    cancel: () => cancelPendingSdAttempt(job, save),
  }
}

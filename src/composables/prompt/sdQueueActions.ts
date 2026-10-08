import { getRuntimeTaskByKey, cancelRuntimeTaskKey } from '@/api/runtimeTasks'
import type { SDQueueJob } from '@/composables/generation/useSDQueue'
import type { RuntimeSdAttempt } from '@/composables/generation/legacySdTaskSession'

type Checkpoint = () => Promise<void>

/** Loaded only when a saved FIFO task is reconciled or cancelled. */
export async function cancelPendingSdAttempt(job: SDQueueJob, save: Checkpoint): Promise<void> {
  const attempt = job.attempt
  if (!attempt) return
  attempt.cancelRequested = true
  await save()
  const task = await cancelRuntimeTaskKey(attempt.key)
  // Another recovery may already have updated the saved row. A late receipt
  // cannot erase that row's current attempt.
  if (job.attempt?.key !== attempt.key) return
  // A null receipt acknowledges the original pre-acceptance cancellation fence.
  // A cleared legacy attempt cannot create a replacement identity.
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
  if (!job.attempt?.submitted) throw new Error('SD 新生成已退役；未提交的旧项可移出，已接收项只查询原编号。')
  const attempt = job.attempt
  const task = await getRuntimeTaskByKey(attempt.key)
  if (!task) throw new Error('上次提交尚未确认，已暂停；请先查询或移出这项任务，不会重复生成')
  return { key: attempt.key, task, cancel: () => cancelPendingSdAttempt(job, save) }
}

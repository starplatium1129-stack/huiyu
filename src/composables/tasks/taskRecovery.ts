import { cancelVideoBatch, cancelVideoJob, fetchVideoBatch, fetchVideoJob } from '@/api/videoApi'
import type { TaskRecord, TaskSummary } from '@/composables/useTaskCenter'
import { generationTask } from '@/utils/generationTask'

export async function queryTask(task: TaskRecord, signal?: AbortSignal): Promise<Partial<TaskSummary>> {
  const backend = task.backend
  if (!backend) return {}
  if (backend.kind === 'video') {
    const { job } = await fetchVideoJob(backend.id, signal)
    const taskState = generationTask(job.status, job.progress)
    return {
      status: taskState.taskStatus, stage: taskState.stage,
      progress: taskState.progress,
      message: job.error || (job.status === 'succeeded' ? '视频已完成，可返回工作台查看。' : '已同步视频任务状态。'),
      resultRoute: job.status === 'succeeded' ? task.route : undefined,
    }
  }
  const { batch } = await fetchVideoBatch(backend.id, signal)
  return {
    status: ['queued', 'running'].includes(batch.status) ? 'running' : batch.status === 'cancelled' ? 'cancelled' : batch.status === 'paused' || batch.progress.failed ? 'failed' : batch.status === 'done' ? 'succeeded' : 'interrupted',
    progress: Math.round((batch.progress.succeeded + batch.progress.failed) / Math.max(1, batch.progress.total) * 100),
    message: `${batch.progress.succeeded} / ${batch.progress.total} 镜完成，${batch.progress.failed} 镜失败`,
    resultRoute: task.route,
  }
}

export async function cancelRecoveredTask(task: TaskRecord, signal?: AbortSignal): Promise<void> {
  if (task.backend?.kind === 'video') await cancelVideoJob(task.backend.id, signal)
  else if (task.backend?.kind === 'video-batch') await cancelVideoBatch(task.backend.id, signal)
}

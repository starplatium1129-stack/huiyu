import type { TaskRecord } from '../../types/tasks'
import type { TaskRequestDraft } from '@/storage/taskRequestDraft'
import { fetchRuntimeResult, runtimeResultPath, taskMessage } from './runtimeTasks'
import { fetchResultImage, jobPath } from './directImageJobs'

export interface ImageTask {
  taskId: string; kind: TaskRequestDraft['kind']; provider: string; input: Record<string, unknown>; metadata: Record<string, unknown>
  status: string; upstreamSettled: boolean; recoveryState: string; resultAvailable: boolean; outputs: number[]
  requestKey: string; createdAt: number; runtimeTask?: TaskRecord
}

export const imageTaskSettled = (task: ImageTask | null) => !!task && task.upstreamSettled && task.recoveryState === 'normal'
  && ['succeeded', 'failed', 'cancelled'].includes(task.status)
export const imageTaskMessage = (task: ImageTask) => task.runtimeTask ? taskMessage(task.runtimeTask)
  : String(task.metadata.progressText || task.metadata.error || ({ succeeded: '处理完成', failed: '处理失败', cancelled: '已取消', queued: '正在排队' }[task.status] || '正在处理…'))

export async function fetchImageTaskResult(task: ImageTask, signal: AbortSignal, index = 0): Promise<Blob> {
  if (!task.outputs.includes(index)) throw new Error('任务尚无这张图片')
  if (task.runtimeTask) return fetchRuntimeResult(runtimeResultPath(task.runtimeTask, index), signal, task.runtimeTask)
  return fetchResultImage(`${jobPath(task.kind === 'lineart' ? 'manga' : task.kind as 'qwen' | 'moss' | 'manga', task.taskId)}/${index === 1 ? 'lineart' : 'result'}`, signal)
}

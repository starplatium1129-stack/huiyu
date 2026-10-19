import { getDesktopRuntime } from '@/platform/desktop/runtime'

export interface WorkspaceJobProgress { phase: string; completed: number; total: number }
interface WorkspaceJob<T> { operationId: string; kind: string; state: 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled'; progress: WorkspaceJobProgress; result?: T; error?: string; code?: string }

/** Only explicit backup/restore/migration work loads this polling lifecycle. */
export async function runWorkspaceJob<T>(request: <R>(command: Record<string, unknown>, signal?: AbortSignal) => Promise<R>,
  command: Record<string, unknown>, signal?: AbortSignal, onProgress?: (value: WorkspaceJobProgress) => void): Promise<T> {
  signal?.throwIfAborted()
  const session = getDesktopRuntime().bootstrap?.runtime?.workspace
  const current = () => {
    const next = getDesktopRuntime().bootstrap?.runtime?.workspace
    if (!session || next?.workspaceId !== session.workspaceId || next.runtimeEpoch !== session.runtimeEpoch || next.principalId !== session.principalId) throw new Error('工作区连接已变化，请回到原工作区续做。')
  }
  let job: WorkspaceJob<T>
  try { job = await request<WorkspaceJob<T>>(command, signal) }
  catch (error) {
    if (!signal?.aborted) throw error
    current()
    job = await request<WorkspaceJob<T>>({ kind: 'jobCancel', operationId: command.operationId })
  }
  let cancelling = false
  for (;;) {
    current()
    if (!job || job.operationId !== command.operationId || job.kind !== command.kind
      || !['running', 'cancelling', 'succeeded', 'failed', 'cancelled'].includes(job.state)
      || !job.progress || typeof job.progress.phase !== 'string' || !Number.isSafeInteger(job.progress.completed) || job.progress.completed < 0
      || !Number.isSafeInteger(job.progress.total) || job.progress.total < 0) throw new Error('工作区长任务回执身份无效。')
    onProgress?.(job.progress)
    if (job.state === 'succeeded') return job.result as T
    if (job.state === 'failed' || job.state === 'cancelled') {
      if (signal?.aborted) throw signal.reason
      throw Object.assign(new Error(job.error || '工作区任务未完成，可继续原操作。'), { code: job.code, operationId: command.operationId })
    }
    if (signal?.aborted && !cancelling) {
      cancelling = true
      job = await request<WorkspaceJob<T>>({ kind: 'jobCancel', operationId: command.operationId })
      continue
    }
    await new Promise(resolve => setTimeout(resolve, 250))
    job = await request<WorkspaceJob<T>>({ kind: 'jobStatus', operationId: command.operationId })
  }
}

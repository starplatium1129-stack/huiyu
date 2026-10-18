import { apiClient, ApiClientError } from '@/api/client'
import { AcceptedTaskTerminalError } from '@/api/acceptedTaskOutcome'
import { fetchResultImage, jobPath, waitForDirectImageJob } from '@/api/directImageJobs'
import { hasRuntimeTasks } from '../../api/runtimeTaskAuthority'
import { runtimeRequestKey } from '@/stores/runtimeTaskState'
import { animaRequestPayload, type AnimaRequest } from '@/composables/generation/animaSessionContract'
import { metadataFromJob } from '../generation/animaJobMetadata'
import type { AnimaJobMetadata, AnimaPublicJob } from '@/types/anima'

interface BatchAnimaOptions {
  requestKey?: string
  onAccepted?: (id: string) => void | Promise<void>
  onSubmitting?: () => void
  signal?: AbortSignal
  resumeId?: string
  reconnect?: boolean
  family?: 'anima' | 'krea2'
}
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted()
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(new DOMException('停止查看', 'AbortError')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    signal.addEventListener('abort', stop, { once: true })
  })
}

/** Transport observes accepted tasks; page disposal only aborts its own reads. */
export function createBatchAnimaTransport(family: () => string) {
  let observer: AbortController | null = null, disposed = false
  const accepted = new Map<string, string>()
  async function run(request: AnimaRequest, context: Record<string, unknown>, cancelled: () => boolean,
    report?: (message: string) => void, options: BatchAnimaOptions = {}): Promise<{ taskId: string } | { blob: Blob; seed?: number; metadata: AnimaJobMetadata }> {
    if (disposed) throw new DOMException('工作台已关闭', 'AbortError')
    observer = new AbortController()
    const signal = AbortSignal.any([observer.signal, ...(options.signal ? [options.signal] : [])])
    const payload = animaRequestPayload(request), selected = options.family || family()
    const signature = options.requestKey || JSON.stringify({ selected, payload, context })
    try {
      signal.throwIfAborted()
      if (hasRuntimeTasks()) {
        const kind = selected === 'krea2' ? 'creative' : 'anima'
        const { submitRuntimeTask, getRuntimeTask, waitForRuntimeTask, taskMessage } = await import('../../api/runtimeTasks')
        signal.throwIfAborted()
        const previous = accepted.get(signature)
        if (options.reconnect && !previous && !options.resumeId) throw new Error('原接收状态尚未确认，不能重新提交。')
        const task = previous || options.resumeId ? await getRuntimeTask(previous || options.resumeId!, signal)
          : await submitRuntimeTask(kind, payload, options.requestKey || runtimeRequestKey(kind, payload), context, { signal, onSubmitting: options.onSubmitting })
        accepted.set(signature, task.taskId)
        await options.onAccepted?.(task.taskId)
        signal.throwIfAborted()
        const done = await waitForRuntimeTask(task.taskId, signal, value => report?.(taskMessage(value)))
        signal.throwIfAborted()
        accepted.delete(signature)
        return { taskId: done.taskId }
      }
      const family = selected === 'krea2' ? 'krea2' : 'anima'
      const route = jobPath(family)
      let data: { ok?: boolean; job?: AnimaPublicJob; error?: string } | undefined
      const knownId = options.resumeId || accepted.get(signature)
      if (options.reconnect && !knownId) throw new Error('原请求接收状态尚未确认，请先核对原任务，不能重新提交。')
      const admissionDeadline = Date.now() + 120_000
      while (!knownId && !data && Date.now() < admissionDeadline) {
        if (cancelled()) throw new DOMException('批量已停止', 'AbortError')
        try { signal.throwIfAborted(); options.onSubmitting?.(); data = await apiClient.request(route, { method: 'POST', body: payload, timeoutMs: 30_000, signal }) }
        catch (error) {
          if (!(error instanceof ApiClientError) || error.status !== 429) throw error
          report?.('队列暂满，等待空位…可点停止结束等待')
          await pause(5000, signal)
        }
      }
      if (!knownId && !data) throw new ApiClientError('队列持续繁忙，请稍后重试本项', { kind: 'http', status: 429 })
      if (!knownId && (data?.ok !== true || !data.job?.id)) throw new ApiClientError(data?.error || 'Anima 接收响应无效', { kind: 'invalid-response' })
      const jobId = knownId || data!.job!.id
      accepted.set(signature, jobId)
      await options.onAccepted?.(jobId)
      const job = await waitForDirectImageJob(family, jobId, signal, { timeoutMs: 10 * 60 * 1000,
        update: job => report?.(job.status === 'queued' ? '已接收，等待生成…' : '正在生成…'),
        reconnecting: () => report?.('连接暂时中断，正在重连同一任务…'),
      }).catch(error => {
        if (error instanceof AcceptedTaskTerminalError && error.taskId === jobId) accepted.delete(signature)
        throw error
      })
      const blob = await fetchResultImage(job.resultUrl, signal)
      const metadata = metadataFromJob(job, request, selected === 'krea2' ? 'krea2' : 'anima')
      accepted.delete(signature)
      return { blob, seed: metadata.seed, metadata }
    } finally { observer = null }
  }
  return { run, dispose() { disposed = true; observer?.abort(); accepted.clear() } }
}

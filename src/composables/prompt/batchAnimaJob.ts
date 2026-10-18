import { ApiClientError } from '@/api/client'
import { fetchResultImage, waitForDirectImageJob } from '@/api/directImageJobs'
import { acceptDirectImageRequest } from '@/api/directImageRequests'
import { DirectRequestRejected } from '@/api/directGenerationRequests'
import { hasRuntimeTasks } from '../../api/runtimeTaskAuthority'
import { animaRequestPayload, type AnimaRequest } from '@/composables/generation/animaSessionContract'
import { metadataFromJob } from '../generation/animaJobMetadata'
import type { AnimaJobMetadata } from '@/types/anima'

interface BatchAnimaOptions {
  requestKey: string
  onAccepted?: (id: string) => void | Promise<void>
  onSubmitting?: () => void
  signal: AbortSignal
  resumeId?: string
  reconnect?: boolean
  family: 'anima' | 'krea2'
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
export function createBatchAnimaTransport() {
  let observer: AbortController | null = null, disposed = false
  async function run(request: AnimaRequest, context: Record<string, unknown>, cancelled: () => boolean,
    report: ((message: string) => void) | undefined, options: BatchAnimaOptions): Promise<{ taskId: string } | { blob: Blob; seed?: number; metadata: AnimaJobMetadata }> {
    if (disposed) throw new DOMException('工作台已关闭', 'AbortError')
    observer = new AbortController()
    const signal = AbortSignal.any([observer.signal, options.signal])
    const payload = animaRequestPayload(request), selected = options.family
    try {
      signal.throwIfAborted()
      if (hasRuntimeTasks()) {
        const kind = selected === 'krea2' ? 'creative' : 'anima'
        const { submitRuntimeTask, waitForRuntimeTask, taskMessage } = await import('../../api/runtimeTasks')
        signal.throwIfAborted()
        if (options.reconnect) throw new Error('原任务必须沿批次按键恢复入口查询，不能重新提交。')
        const task = await submitRuntimeTask(kind, payload, options.requestKey, context, { signal, onSubmitting: options.onSubmitting })
        await options.onAccepted?.(task.taskId)
        signal.throwIfAborted()
        const done = await waitForRuntimeTask(task.taskId, signal, value => report?.(taskMessage(value)))
        signal.throwIfAborted()
        return { taskId: done.taskId }
      }
      const family = selected === 'krea2' ? 'krea2' : 'anima'
      let submitted = Boolean(options.reconnect), jobId = options.resumeId
      const admissionDeadline = Date.now() + 120_000
      while (!jobId && Date.now() < admissionDeadline) {
        if (cancelled()) throw new DOMException('批量已停止', 'AbortError')
        try { jobId = (await acceptDirectImageRequest(family, payload, options.requestKey, { signal, resume: submitted,
          onSubmitting: () => { options.onSubmitting?.(); submitted = true },
        })).id }
        catch (error) {
          if (!(error instanceof DirectRequestRejected) || error.status !== 429) throw error
          submitted = false
          report?.('队列暂满，等待空位…可点停止结束等待')
          await pause(5000, signal)
        }
      }
      if (!jobId) throw new ApiClientError('队列持续繁忙，请稍后重试本项', { kind: 'http', status: 429 })
      await options.onAccepted?.(jobId)
      const job = await waitForDirectImageJob(family, jobId, signal, { timeoutMs: 10 * 60 * 1000,
        update: job => report?.(job.status === 'queued' ? '已接收，等待生成…' : '正在生成…'),
        reconnecting: () => report?.('连接暂时中断，正在重连同一任务…'),
      })
      const blob = await fetchResultImage(job.resultUrl, signal)
      const metadata = metadataFromJob(job, request, selected === 'krea2' ? 'krea2' : 'anima')
      return { blob, seed: metadata.seed, metadata }
    } finally { observer = null }
  }
  return { run, dispose() { disposed = true; observer?.abort() } }
}

import { apiClient, ApiClientError, type ApiClient } from './client'
import { AcceptedTaskTerminalError } from './acceptedTaskOutcome'
import { runtimeFetch, runtimeResourceIdentity } from '@/platform/runtimeUrl'
import type { AnimaPublicJob } from '@/types/anima'

export type DirectImageFamily = 'anima' | 'krea2' | 'qwen' | 'moss' | 'manga'
export function jobPath(family: DirectImageFamily, id?: string): string {
  const base = `/api/${family === 'krea2' ? 'creative' : family}/jobs`
  return id ? `${base}/${encodeURIComponent(id)}` : base
}
export function assertDirectImageRuntime(owner: string): void {
  if (owner !== runtimeResourceIdentity()) throw new ApiClientError('运行时连接已更换，请核对原任务', { kind: 'aborted', code: 'RUNTIME_EPOCH_CHANGED' })
}

export function imageJob(value: Record<string, unknown>, id: string): AnimaPublicJob {
  const job = value.job as AnimaPublicJob | undefined
  if (value.ok !== true || !job || job.id !== id
    || !['queued', 'submitting', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled'].includes(job.status)
    || typeof job.resultAvailable !== 'boolean' || !(job.resultUrl === null || typeof job.resultUrl === 'string')
    || job.upstreamSettled !== undefined && typeof job.upstreamSettled !== 'boolean'
    || job.unknown !== undefined && typeof job.unknown !== 'boolean') {
    throw new ApiClientError('图片任务响应与原编号或状态不符，请核对原任务', { kind: 'invalid-response' })
  }
  return job
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    signal.addEventListener('abort', stop, { once: true })
  })
}

/** Observe one accepted browser job. Submission, cancellation and result ownership stay with its caller. */
export async function waitForDirectImageJob(family: DirectImageFamily, id: string, signal: AbortSignal, options: {
  timeoutMs: number; client?: ApiClient; intervalMs?: number; immediate?: boolean
  update?: (job: AnimaPublicJob) => void; reconnecting?: () => void
}): Promise<AnimaPublicJob & { resultUrl: string }> {
  const deadline = Date.now() + options.timeoutMs, owner = runtimeResourceIdentity()
  const client = options.client ?? apiClient
  let immediate = options.immediate === true
  for (;;) {
    signal.throwIfAborted()
    if (!immediate) await pause(options.intervalMs ?? 1000, signal)
    immediate = false
    assertDirectImageRuntime(owner)
    if (Date.now() >= deadline) throw new ApiClientError('等待结果超时，原任务仍保留；请核对后继续。', { kind: 'timeout', code: 'IMAGE_JOB_OBSERVATION_TIMEOUT' })
    let data: Record<string, unknown>
    try { data = await client.request(jobPath(family, id), { cache: 'no-store', signal, timeoutMs: 15_000 }) }
    catch (error) {
      signal.throwIfAborted()
      if (!(error instanceof ApiClientError) || !(error.kind === 'network' || error.kind === 'timeout' || error.kind === 'http' && error.status >= 500)) throw error
      options.reconnecting?.(); continue
    }
    signal.throwIfAborted()
    assertDirectImageRuntime(owner)
    const job = imageJob(data, id)
    options.update?.(job)
    if (job.status === 'failed' || job.status === 'cancelled') {
      if (job.upstreamSettled !== true || job.unknown !== false)
        throw new ApiClientError('上游接收或终止状态尚未确认，请核对原请求；不会重复生成。', { kind: 'network', code: 'IMAGE_JOB_OUTCOME_UNKNOWN' })
      throw new AcceptedTaskTerminalError(id, job.status, job.error || (job.status === 'failed' ? '图片生成失败' : '任务已取消'))
    }
    if (job.status === 'succeeded' && job.resultAvailable && job.resultUrl) return { ...job, resultUrl: job.resultUrl }
  }
}

/** One bounded binary read shared by single images, batches and storyboard first frames. */
export async function fetchResultImage(url: string, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted()
  const timeout = AbortSignal.timeout(30_000)
  const owner = runtimeResourceIdentity()
  let response: Response | undefined
  try {
    response = await runtimeFetch(url, { cache: 'no-store', signal: AbortSignal.any([signal, timeout]) })
    if (!response.ok) throw new Error(`图片读取失败（HTTP ${response.status}）`)
    if (!response.headers.get('content-type')?.startsWith('image/')) throw new Error('网关返回的结果不是图片')
    const blob = await response.blob()
    signal.throwIfAborted()
    assertDirectImageRuntime(owner)
    if (!blob.size) throw new Error('生成结果为空')
    return blob
  } catch (error) {
    signal.throwIfAborted()
    if (timeout.aborted) throw new Error('图片读取超时（30 秒）')
    throw error
  } finally {
    if (response && !response.bodyUsed) await response.body?.cancel().catch(() => {})
  }
}

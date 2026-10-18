import { apiClient, ApiClientError, type ApiClient } from './client'
import { assertDirectImageRuntime, imageJob, jobPath } from './directImageJobs'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import type { AnimaPublicJob } from '@/types/anima'

type Family = 'anima' | 'krea2'
export const imageRequestPath = (family: Family, key: string) => jobPath(family).replace(/\/jobs$/, '/requests/') + encodeURIComponent(key)
/** Only a saved rejection proves that this request never reached execution. */
export class DirectImageRequestRejected extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message) }
}
function pause(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, 1500)
    signal.addEventListener('abort', stop, { once: true })
  })
}
/** Exactly one POST; a lost response or an existing attempt permits only GET.
 * The caller must retain the key before sending, including across its own restores. */
export async function acceptDirectImageRequest(family: Family, input: Record<string, unknown>, key: string, options: {
  signal: AbortSignal; resume?: boolean; client?: ApiClient; onSubmitting?: () => void
}): Promise<AnimaPublicJob> {
  const { signal } = options, client = options.client ?? apiClient, owner = runtimeResourceIdentity()
  const deadline = Date.now() + 150_000
  let data: Record<string, unknown> | undefined
  signal.throwIfAborted()
  if (!options.resume) {
    assertDirectImageRuntime(owner)
    options.onSubmitting?.()
    try { data = await client.request<Record<string, unknown>>(jobPath(family), { method: 'POST', body: { ...input, requestKey: key }, signal, timeoutMs: 30_000 }) }
    catch (error) {
      signal.throwIfAborted(); assertDirectImageRuntime(owner)
      if (error instanceof ApiClientError && error.kind === 'http' && error.status < 500) {
        if (error.status === 429) throw new DirectImageRequestRejected(error.message, error.code || 'RATE_LIMITED', 429)
        throw error
      }
      // Transport failure says nothing about acceptance. Never repeat the POST.
    }
  }
  for (;;) {
    signal.throwIfAborted(); assertDirectImageRuntime(owner)
    if (data) {
      if (data.ok !== true || data.requestKey !== key) throw new ApiClientError('图片接收凭据与原请求不符，请核对原任务。', { kind: 'invalid-response' })
      if (data.rejected && typeof data.rejected === 'object') {
        const rejected = data.rejected as Record<string, unknown>
        if (typeof rejected.message !== 'string' || typeof rejected.code !== 'string' || !Number.isInteger(rejected.status))
          throw new ApiClientError('图片接收拒绝凭据无效', { kind: 'invalid-response' })
        throw new DirectImageRequestRejected(rejected.message, rejected.code, rejected.status as number)
      }
      if (data.job) {
        const id = (data.job as Record<string, unknown>).id
        if (typeof id !== 'string' || !id) throw new ApiClientError('图片接收任务编号无效', { kind: 'invalid-response' })
        return imageJob(data, id)
      }
      if (data.job !== null) throw new ApiClientError('图片接收记录无效', { kind: 'invalid-response' })
    }
    if (Date.now() >= deadline) throw new ApiClientError('接收状态尚未确认，请重新查询原请求；不会重复生成。', { kind: 'network', code: 'IMAGE_ACCEPTANCE_UNKNOWN' })
    await pause(signal)
    try { data = await client.request<Record<string, unknown>>(imageRequestPath(family, key), { signal, cache: 'no-store', cachePolicy: 'bypass', timeoutMs: 15_000 }) }
    catch (error) {
      signal.throwIfAborted(); assertDirectImageRuntime(owner)
      if (!(error instanceof ApiClientError) || !(error.kind === 'network' || error.kind === 'timeout' || error.kind === 'http' && error.status >= 500)) throw error
      data = undefined
    }
  }
}
export async function cancelDirectImageRequest(family: Family, key: string, owner: string, client: ApiClient = apiClient): Promise<void> {
  assertDirectImageRuntime(owner)
  const data = await client.request<Record<string, unknown>>(imageRequestPath(family, key), { method: 'DELETE', timeoutMs: 15_000 })
  assertDirectImageRuntime(owner)
  if (data.ok !== true || data.requestKey !== key || data.cancelRequested !== true) throw new Error('图片取消意图尚未确认，请重新核对原请求。')
}

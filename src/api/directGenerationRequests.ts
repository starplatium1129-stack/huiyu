import { apiClient, ApiClientError, type ApiClient } from './client'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'

/** Only a saved rejection proves that this request never reached execution. */
export class DirectRequestRejected extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message) }
}
export interface DirectRequestOptions {
  signal: AbortSignal
  resume?: boolean
  client?: ApiClient
  onSubmitting?: () => void
}
interface DirectRequest<T extends object> {
  key: string
  submitPath: string
  receiptPath: string
  body: Record<string, unknown>
  field: 'job' | 'batch'
  decode: (value: Record<string, unknown>) => T
}
function assertRuntime(owner: string) {
  if (owner !== runtimeResourceIdentity()) throw new ApiClientError('运行时连接已更换，请核对原任务', { kind: 'aborted', code: 'RUNTIME_EPOCH_CHANGED' })
}
function pause(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, 1500)
    signal.addEventListener('abort', stop, { once: true })
  })
}
function readReceipt<T extends object>(request: DirectRequest<T>, value: Record<string, unknown>): T | null {
  if (value.ok !== true || value.requestKey !== request.key)
    throw new ApiClientError('接收凭据与原请求不符，请核对原任务。', { kind: 'invalid-response' })
  if (value.rejected && typeof value.rejected === 'object') {
    const rejected = value.rejected as Record<string, unknown>
    if (typeof rejected.message !== 'string' || typeof rejected.code !== 'string' || !Number.isInteger(rejected.status)
      || Number(rejected.status) < 400 || Number(rejected.status) > 599)
      throw new ApiClientError('接收拒绝凭据无效', { kind: 'invalid-response' })
    throw new DirectRequestRejected(rejected.message, rejected.code, rejected.status as number)
  }
  if (value[request.field]) return request.decode(value)
  if (value[request.field] !== null) throw new ApiClientError('接收记录无效', { kind: 'invalid-response' })
  return null
}
/** Exactly one POST; a lost response or an existing attempt permits only GET.
 * The caller retains the key before sending, including across its own restores. */
export async function acceptDirectGenerationRequest<T extends object>(request: DirectRequest<T>, options: DirectRequestOptions): Promise<T> {
  const { signal } = options, client = options.client ?? apiClient, owner = runtimeResourceIdentity()
  const deadline = Date.now() + 150_000
  let data: Record<string, unknown> | undefined
  signal.throwIfAborted()
  if (!options.resume) {
    assertRuntime(owner)
    options.onSubmitting?.()
    try { data = await client.request<Record<string, unknown>>(request.submitPath, { method: 'POST', body: { ...request.body, requestKey: request.key }, signal, timeoutMs: 30_000 }) }
    catch (error) {
      signal.throwIfAborted(); assertRuntime(owner)
      // Even an ingress 429 can follow an earlier accepted attempt. A bare
      // HTTP error cannot prove that the saved key has no consumer.
      if (error instanceof ApiClientError && error.kind === 'http' && error.status < 500) throw error
      // Transport failure says nothing about acceptance. Never repeat the POST.
    }
  }
  for (;;) {
    signal.throwIfAborted(); assertRuntime(owner)
    if (data) {
      const accepted = readReceipt(request, data)
      if (accepted) return accepted
    }
    if (Date.now() >= deadline) throw new ApiClientError('接收状态尚未确认，请重新查询原请求；不会重复生成。', { kind: 'network', code: 'GENERATION_ACCEPTANCE_UNKNOWN' })
    if (data !== undefined || !options.resume) await pause(signal)
    try { data = await client.request<Record<string, unknown>>(request.receiptPath, { signal, cache: 'no-store', cachePolicy: 'bypass', timeoutMs: 15_000 }) }
    catch (error) {
      signal.throwIfAborted(); assertRuntime(owner)
      if (!(error instanceof ApiClientError) || !(error.kind === 'network' || error.kind === 'timeout' || error.kind === 'http' && error.status >= 500)) throw error
      data = undefined
      await pause(signal)
    }
  }
}
/** DELETE records cancellation even when a disconnected submit has no task ID yet. */
export async function cancelDirectGenerationRequest<T extends object>(request: DirectRequest<T>, options: { signal?: AbortSignal; client?: ApiClient } = {}): Promise<T | null> {
  const owner = runtimeResourceIdentity()
  options.signal?.throwIfAborted(); assertRuntime(owner)
  const value = await (options.client ?? apiClient).request<Record<string, unknown>>(request.receiptPath, { method: 'DELETE', signal: options.signal, timeoutMs: 15_000 })
  options.signal?.throwIfAborted(); assertRuntime(owner)
  if (value.ok !== true || value.requestKey !== request.key || value.cancelRequested !== true)
    throw new ApiClientError('取消意图尚未确认，请重新核对原请求。', { kind: 'invalid-response' })
  return value[request.field] === null ? null : request.decode(value)
}

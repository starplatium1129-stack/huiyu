import { apiClient } from './client'
import { runtimeFetch } from '@/platform/runtimeUrl'
import { decodeInterrogateReadiness } from '@/composables/useInterrogateReadiness'
import { decodeInterrogateResult, type InterrogateResult } from './interrogateResult'

/** Companion uses the same local PixAI readiness and response contracts as the workbench. */
export async function interrogateImage(source: string, signal: AbortSignal): Promise<InterrogateResult> {
  const ready = decodeInterrogateReadiness(await apiClient.request('/api/interrogate/status', {
    cache: 'no-store', cachePolicy: 'bypass', timeoutMs: 8000, signal,
  }))
  if (ready.state !== 'ready') throw new Error(ready.message)
  const active = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
  try {
  const response = await runtimeFetch(source, { signal: active })
  if (!response.ok) throw new Error('参考图片无法读取，请重新发送')
  const blob = await response.blob()
  if (!blob.type.startsWith('image/') || !blob.size || blob.size > 20 * 1024 * 1024) throw new Error('参考图片需为不超过 20MB 的图片')
  const image = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    const abort = () => { reader.abort(); reject(new DOMException('反推已取消', 'AbortError')) }
    active.throwIfAborted(); active.addEventListener('abort', abort, { once: true })
    const cleanup = () => active.removeEventListener('abort', abort)
    reader.onload = () => { cleanup(); resolve(String(reader.result)) }
    reader.onerror = () => { cleanup(); reject(new Error('读取参考图片失败')) }
    reader.onabort = cleanup
    reader.readAsDataURL(blob)
  })
  active.throwIfAborted()
  const result = await runtimeFetch('/api/interrogate', { method: 'POST', signal: active,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image, mode: 'tag', threshold: 0.17 }) })
  const envelope: unknown = await result.json().catch(() => null)
  if (!result.ok || !envelope || typeof envelope !== 'object' || !('ok' in envelope) || envelope.ok !== true) {
    throw new Error(result.status === 403 ? '请在本机使用图片反推' : result.status === 413 ? '参考图片过大' : '反推服务暂不可用，请检查绘图里的反推设置')
  }
  return decodeInterrogateResult(envelope, 'tag')
  } catch (error) {
    if (active.aborted && !signal.aborted) throw new Error('图片反推等待超时，请检查反推服务后重试')
    throw error
  }
}

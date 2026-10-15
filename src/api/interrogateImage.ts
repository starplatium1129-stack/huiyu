import { apiClient } from './client'
import { runtimeFetch } from '@/platform/runtimeUrl'
import { decodeInterrogateReadiness } from '@/composables/useInterrogateReadiness'
import { decodeInterrogateResult, type InterrogateMode, type InterrogateResult } from './interrogateResult'
import { assertWorkspaceMediaAuthority, type MediaSource } from '@/platform/desktop/workspaceMediaSource'

function interrogateFailure(status: number): string {
  return status === 413 ? '图片过大，请换一张较小的图片'
    : status === 429 ? '操作太频繁，请稍后再试'
    : status === 400 ? '无法读取这张图片，请换一张重试'
    : status === 403 ? '请在本机使用图片反推'
    : status === 404 || status >= 500 ? '反推服务暂不可用，请稍后重试'
    : '反推失败，请重试'
}

/** Both callers have checked readiness and own cancellation before reaching image I/O. */
export async function interrogateImageFile(file: Blob, signal: AbortSignal,
  mode: InterrogateMode = 'tag', threshold = 0.17): Promise<InterrogateResult> {
  signal.throwIfAborted()
  if (!file.size) throw new Error('请选择图片')
  if (file.size > 20 * 1024 * 1024) throw new Error('图片超过 20MB 限制')
  if (!file.type.startsWith('image/')) throw new Error('仅支持图片文件')
  const query = new URLSearchParams({ mode, threshold: String(threshold) })
  const response = await runtimeFetch(`/api/interrogate/raw?${query}`, { method: 'POST', signal,
    headers: { 'Content-Type': 'application/octet-stream' }, body: file })
  return readResult(response, signal, mode)
}

async function readResult(response: Response, signal: AbortSignal, mode: InterrogateMode): Promise<InterrogateResult> {
  const json: unknown = await response.json().catch(() => null)
  signal.throwIfAborted()
  const envelope = json && typeof json === 'object' && !Array.isArray(json) ? json as Record<string, unknown> : null
  if (!response.ok || !envelope || envelope.ok !== true) {
    const message = typeof envelope?.error === 'string' ? envelope.error
      : typeof envelope?.message === 'string' ? envelope.message : ''
    console.warn('[interrogate] Request failed', { status: response.status, message })
    throw new Error(interrogateFailure(response.status))
  }
  return decodeInterrogateResult(envelope, mode)
}

/** Companion uses the same local PixAI readiness and response contracts as the workbench. */
export async function interrogateImage(source: string | Readonly<MediaSource>, signal: AbortSignal): Promise<InterrogateResult> {
  if (typeof source !== 'string') assertWorkspaceMediaAuthority(source.authority)
  const ready = decodeInterrogateReadiness(await apiClient.request('/api/interrogate/status', {
    cache: 'no-store', cachePolicy: 'bypass', timeoutMs: 8000, signal,
  }))
  if (ready.state !== 'ready') throw new Error(ready.message)
  const active = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
  try {
    if (typeof source !== 'string') {
      assertWorkspaceMediaAuthority(source.authority)
      const { alias, sha256, bytes, mime } = source
      const response = await runtimeFetch('/api/workspace/interrogate', { method: 'POST', signal: active,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'workspace', alias, sha256, bytes, mime }) })
      const result = await readResult(response, active, 'tag')
      assertWorkspaceMediaAuthority(source.authority)
      return result
    }
    const response = await runtimeFetch(source, { signal: active })
    if (!response.ok) throw new Error('参考图片无法读取，请重新发送')
    const blob = await response.blob()
    return await interrogateImageFile(blob, active)
  } catch (error) {
    if (active.aborted && !signal.aborted) throw new Error('图片反推等待超时，请检查反推服务后重试')
    throw error
  }
}

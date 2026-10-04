import type { FetchImplementation } from './client.ts'
import type { LocalSetupVerificationProgress, LocalSetupVerificationResult } from '../../types/local-setup.ts'
import { isLocalStudioHost } from '../utils/runtimeEnvironment.ts'

export interface VerificationOptions {
  signal: AbortSignal
  onProgress: (event: LocalSetupVerificationProgress) => void
}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const nullableBytes = (value: unknown) => value === null || integer(value)
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** This explicit request has no cache and must receive a terminal result. */
export async function verifyLocalSetupModel(modelId: string, options: VerificationOptions, fetch: FetchImplementation = (url, init) => globalThis.fetch(url, init)): Promise<LocalSetupVerificationResult> {
  if (!isLocalStudioHost()) throw new Error('模型校验仅限本机使用')
  if (!['anima-aesthetic-v1.1', 'qwen-encoder', 'qwen-vae'].includes(modelId)) throw new Error('模型不在起步校验清单中')
  options.signal.throwIfAborted()
  const response = await fetch(`/api/local-setup/verify/${encodeURIComponent(modelId)}`, { method: 'POST', cache: 'no-store', signal: options.signal })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    throw new Error(object(body) && typeof body.error === 'string' ? body.error : `模型校验请求失败（${response.status}）`)
  }
  if (!response.body || !response.headers.get('content-type')?.includes('application/x-ndjson')) throw new Error('模型校验返回了无效响应')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', terminal: LocalSetupVerificationResult | undefined
  const consume = (line: string) => {
    if (!line.trim()) return
    const event: unknown = JSON.parse(line)
    if (!object(event) || event.modelId !== modelId) throw new Error('模型校验返回了不匹配的数据')
    if (event.type === 'progress' && integer(event.bytesRead) && integer(event.expectedBytes) && event.expectedBytes > 0 && event.bytesRead <= event.expectedBytes) {
      options.onProgress(event as unknown as LocalSetupVerificationProgress)
    } else if (event.type === 'result' && typeof event.path === 'string' && typeof event.message === 'string'
      && ['sha256-match', 'hash-mismatch', 'size-mismatch', 'missing', 'changed', 'unknown'].includes(String(event.state))
      && nullableBytes(event.bytes) && integer(event.checkedAt)
      && (event.sha256 === null || (typeof event.sha256 === 'string' && /^[a-f0-9]{64}$/.test(event.sha256)))
      && (!['sha256-match', 'hash-mismatch'].includes(String(event.state)) || event.sha256 !== null)) {
      terminal = event as unknown as LocalSetupVerificationResult
    } else throw new Error('模型校验返回了无效数据')
  }
  const cancelReader = () => { void reader.cancel().catch(() => {}) }
  options.signal.addEventListener('abort', cancelReader, { once: true })
  try {
    while (!terminal) {
      options.signal.throwIfAborted()
      const part = await reader.read()
      options.signal.throwIfAborted()
      buffer += decoder.decode(part.value, { stream: !part.done })
      if (buffer.length > 64 * 1024) throw new Error('模型校验响应过大')
      const lines = buffer.split('\n'); buffer = lines.pop()!
      for (const line of lines) { consume(line); if (terminal) break }
      if (part.done) { if (!terminal && buffer.trim()) consume(buffer); break }
    }
    if (!terminal) throw new Error('模型校验意外中断，未收到完整结果')
    return terminal
  } finally {
    options.signal.removeEventListener('abort', cancelReader)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

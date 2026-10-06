import { runtimeFetch } from '../platform/runtimeUrl.ts'
import type { FetchImplementation } from './client.ts'
import type { LocalSetupVerificationProgress, LocalSetupVerificationResult } from '../../types/local-setup.ts'
import { isLocalStudioHost } from '../utils/runtimeEnvironment.ts'
import { readLocalSetupStream } from './localSetupStream.ts'
import { localSetupModelIds } from './localSetupCatalog'

export interface VerificationOptions {
  signal: AbortSignal
  onProgress: (event: LocalSetupVerificationProgress) => void
}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const nullableBytes = (value: unknown) => value === null || integer(value)
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** This explicit request has no cache and must receive a terminal result. */
export async function verifyLocalSetupModel(modelId: string, options: VerificationOptions, fetch: FetchImplementation = runtimeFetch): Promise<LocalSetupVerificationResult> {
  if (!isLocalStudioHost()) throw new Error('模型校验仅限本机使用')
  if (!localSetupModelIds.has(modelId)) throw new Error('模型不在已登记的校验清单中')
  options.signal.throwIfAborted()
  const response = await fetch(`/api/local-setup/verify/${encodeURIComponent(modelId)}`, { method: 'POST', cache: 'no-store', signal: options.signal })
  return readLocalSetupStream<LocalSetupVerificationResult>(response, options.signal, event => {
    if (!object(event) || event.modelId !== modelId) throw new Error('模型校验返回了不匹配的数据')
    if (event.type === 'progress' && integer(event.bytesRead) && integer(event.expectedBytes) && event.expectedBytes > 0 && event.bytesRead <= event.expectedBytes) {
      options.onProgress(event as unknown as LocalSetupVerificationProgress)
    } else if (event.type === 'result' && typeof event.path === 'string' && typeof event.message === 'string'
      && ['sha256-match', 'hash-mismatch', 'size-mismatch', 'missing', 'changed', 'unknown'].includes(String(event.state))
      && nullableBytes(event.bytes) && integer(event.checkedAt)
      && (event.sha256 === null || (typeof event.sha256 === 'string' && /^[a-f0-9]{64}$/.test(event.sha256)))
      && (!['sha256-match', 'hash-mismatch'].includes(String(event.state)) || event.sha256 !== null)) {
      return event as unknown as LocalSetupVerificationResult
    } else throw new Error('模型校验返回了无效数据')
  })
}

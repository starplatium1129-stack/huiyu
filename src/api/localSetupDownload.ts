import { runtimeFetch } from '../platform/runtimeUrl.ts'
import { isLocalStudioHost } from '../utils/runtimeEnvironment.ts'
import type { FetchImplementation } from './client.ts'
import type { LocalSetupDownloadProgress, LocalSetupDownloadResult } from '../../types/local-setup.ts'
import { readLocalSetupStream } from './localSetupStream.ts'

export interface DownloadOptions {
  workspacePath: string
  signal: AbortSignal
  onProgress: (event: LocalSetupDownloadProgress) => void
}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
export async function downloadLocalSetupModel(modelId: string, options: DownloadOptions, fetch: FetchImplementation = runtimeFetch): Promise<LocalSetupDownloadResult> {
  if (!isLocalStudioHost()) throw new Error('模型下载仅限本机使用')
  if (!['anima-aesthetic-v1.1', 'qwen-encoder', 'qwen-vae'].includes(modelId)) throw new Error('模型不在起步下载清单中')
  options.signal.throwIfAborted()
  const response = await fetch(`/api/local-setup/download/${encodeURIComponent(modelId)}`, {
    method: 'POST', cache: 'no-store', signal: options.signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspacePath: options.workspacePath, reviewed: true }),
  })
  return readLocalSetupStream<LocalSetupDownloadResult>(response, options.signal, event => {
    if (!object(event) || event.modelId !== modelId) throw new Error('模型下载返回了不匹配的数据')
    if (event.type === 'progress' && ['checking', 'downloading', 'verifying'].includes(String(event.phase))
      && integer(event.bytesRead) && integer(event.expectedBytes) && event.expectedBytes > 0 && event.bytesRead <= event.expectedBytes) {
      options.onProgress(event as unknown as LocalSetupDownloadProgress)
    } else if (event.type === 'result' && typeof event.path === 'string' && typeof event.message === 'string' && integer(event.checkedAt)
      && ['downloaded', 'already-present', 'failed'].includes(String(event.state))
      && (event.bytes === null || integer(event.bytes)) && (event.code === null || typeof event.code === 'string')
      && (event.sha256 === null || (typeof event.sha256 === 'string' && /^[a-f0-9]{64}$/.test(event.sha256)))
      && (event.state === 'failed' || (integer(event.bytes) && event.bytes > 0 && event.sha256 !== null && event.code === null))) {
      return event as unknown as LocalSetupDownloadResult
    } else throw new Error('模型下载返回了无效数据')
  })
}

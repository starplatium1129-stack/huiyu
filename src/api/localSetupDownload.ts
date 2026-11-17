import { runtimeFetch } from '../platform/runtimeUrl.ts'
import { isLocalStudioHost } from '../utils/runtimeEnvironment.ts'
import type { LocalSetupDownloadProgress, LocalSetupDownloadResult } from '../../types/local-setup.ts'
import { readLocalSetupStream } from './localSetupStream.ts'
import { localSetupModelIds } from './localSetupCatalog'

export interface DownloadOptions {
  workspacePath: string
  signal: AbortSignal
  onProgress: (event: LocalSetupDownloadProgress) => void
}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
function downloadRequest(modelIds: readonly string[], options: DownloadOptions, batch = false) {
  if (!isLocalStudioHost()) throw new Error('模型下载仅限本机使用')
  if (!modelIds.length || new Set(modelIds).size !== modelIds.length || !modelIds.every(id => localSetupModelIds.has(id))) {
    throw new Error('模型不在已登记的下载清单中，或清单存在重复')
  }
  options.signal.throwIfAborted()
  const url = batch ? '/api/local-setup/download-batch' : `/api/local-setup/download/${encodeURIComponent(modelIds[0]!)}`
  return runtimeFetch(url, {
    method: 'POST', cache: 'no-store', signal: options.signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspacePath: options.workspacePath, reviewed: true, ...(batch ? { modelIds } : {}) }),
  })
}

function downloadEvent(event: unknown, pending: ReadonlySet<string>): LocalSetupDownloadProgress | LocalSetupDownloadResult {
  if (!object(event) || typeof event.modelId !== 'string' || !pending.has(event.modelId)) throw new Error('模型下载返回了不匹配的数据')
  if (event.type === 'progress' && ['checking', 'connecting', 'downloading', 'retrying', 'verifying'].includes(String(event.phase))
    && (event.message === undefined || typeof event.message === 'string')
    && (event.source === undefined || typeof event.source === 'string')
    && (event.bytesPerSecond == null || (typeof event.bytesPerSecond === 'number' && Number.isFinite(event.bytesPerSecond) && event.bytesPerSecond >= 0))
    && integer(event.bytesRead) && integer(event.expectedBytes) && event.expectedBytes > 0 && event.bytesRead <= event.expectedBytes) {
    return event as unknown as LocalSetupDownloadProgress
  }
  if (event.type === 'result' && typeof event.path === 'string' && typeof event.message === 'string' && integer(event.checkedAt)
    && ['downloaded', 'already-present', 'failed'].includes(String(event.state))
    && (event.bytes === null || integer(event.bytes)) && (event.code === null || typeof event.code === 'string')
    && (event.sha256 === null || (typeof event.sha256 === 'string' && /^[a-f0-9]{64}$/.test(event.sha256)))
    && (event.state === 'failed' || (integer(event.bytes) && event.bytes > 0 && event.sha256 !== null && event.code === null))) {
    return event as unknown as LocalSetupDownloadResult
  }
  throw new Error('模型下载返回了无效数据')
}

export async function downloadLocalSetupModel(modelId: string, options: DownloadOptions): Promise<LocalSetupDownloadResult> {
  const response = await downloadRequest([modelId], options)
  const pending = new Set([modelId])
  return readLocalSetupStream(response, options.signal, value => {
    const event = downloadEvent(value, pending)
    if (event.type === 'result') return event
    options.onProgress(event)
  })
}

export async function downloadLocalSetupBatch(
  modelIds: readonly string[],
  options: DownloadOptions & { onResult: (event: LocalSetupDownloadResult) => void },
): Promise<void> {
  const response = await downloadRequest(modelIds, options, true)
  const pending = new Set(modelIds)
  await readLocalSetupStream(response, options.signal, value => {
    if (object(value) && value.type === 'complete') {
      if (pending.size) throw new Error('模型下载批次未收到所有文件结果')
      return true
    }
    const event = downloadEvent(value, pending)
    if (event.type === 'progress') options.onProgress(event)
    else {
      pending.delete(event.modelId)
      options.onResult(event)
    }
  })
}

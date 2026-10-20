import { PendingMediaUploadError } from '../../application/artwork/mediaUpload.ts'
import { WORKSPACE_MEDIA_PENDING_PREFIX } from '../../utils/storageKeys.ts'
import { getDesktopRuntime, onDesktopRuntime } from './runtime.ts'
import { assertWorkspaceMediaAuthority, rememberWorkspaceMedia, workspaceMediaAuthority } from './workspaceMediaSource.ts'
import { imageBlobDigest } from '../../utils/imageBlobDigest.ts'
import { uploadArtworkChunks } from './artworkUploadChunks.ts'

type Request = <T>(command: Record<string, unknown>) => Promise<T>
interface Pending { operationId: string; imageId: string }
interface Receipt { operationId: string; kind: string; revision: number }
interface Operation {
  operationId: string; kind: string; state: string; receipt?: Receipt
  media?: { alias: string; sha256: string; bytes: number; mime: string; writtenBytes: number }
}

/** Local intent markers only; runtime operations/receipts remain the durable authority.
 * Keep unresolved markers indefinitely: no lease/ref expiry or implicit abandonment.
 * A successful handoff removes its marker so equal bytes in independent saves get
 * separate aliases/temporary ownership. Web Locks serialize that handoff across windows.
 */
export async function putDesktopArtworkImage(blob: Blob, request: Request): Promise<string> {
  const authority = workspaceMediaAuthority()
  const { workspaceId, principalId } = getDesktopRuntime().bootstrap!.runtime!.workspace!
  // Equal authority fields after reconnect do not revive this upload.
  const controller = new AbortController()
  const assertCurrent = () => {
    controller.signal.throwIfAborted()
    assertWorkspaceMediaAuthority(authority)
  }
  const stopRuntime = onDesktopRuntime(() => { try { assertCurrent() } catch { controller.abort() } })
  try {
    const send: Request = async command => { assertCurrent(); return request(command) }
    const { bytes, sha256 } = await imageBlobDigest(blob, assertCurrent)
    const key = WORKSPACE_MEDIA_PENDING_PREFIX + JSON.stringify([workspaceId, principalId, sha256, bytes.length, blob.type])
    if (!navigator.locks?.request) throw new Error('当前环境不支持跨窗口安全上传，请使用新版桌面应用。')
    return await navigator.locks.request(key, { signal: controller.signal }, async () => {
      assertCurrent()
      const stored = localStorage.getItem(key)
      let pending: Pending
      try {
        pending = stored === null ? { operationId: crypto.randomUUID(), imageId: `image-${crypto.randomUUID()}` } : JSON.parse(stored)
        if (!pending || typeof pending.operationId !== 'string' || !/^[0-9a-f-]{36}$/.test(pending.operationId)
          || typeof pending.imageId !== 'string' || !/^image-[0-9a-f-]{36}$/.test(pending.imageId)) throw new Error('invalid marker')
      } catch { throw new Error('图片上传恢复标记异常，原标记已保留。') }
      const marker = JSON.stringify(pending)
      // Fail before creating any runtime lease if the retry identity cannot be saved.
      if (stored === null) localStorage.setItem(key, marker)
      const { operationId, imageId } = pending
      const media = { alias: imageId, sha256, bytes: bytes.length, mime: blob.type }
      const validReceipt = (receipt?: Receipt) => receipt?.operationId === operationId && receipt.kind === 'commitMedia'
        && Number.isSafeInteger(receipt.revision) && receipt.revision >= 0
      const validOperation = (operation: Operation) => operation.operationId === operationId && operation.kind === 'prepareMedia'
        && ['prepared', 'committed'].includes(operation.state)
      const handoff = () => {
        assertCurrent()
        if (localStorage.getItem(key) !== (stored ?? marker)) throw new Error('图片上传恢复标记已变化，请重新读取。')
        localStorage.removeItem(key)
        rememberWorkspaceMedia(blob, media, authority)
        return imageId
      }
      let prepared = false
      try {
        // Same identity/input is idempotent, including a lost prepare or chunk reply.
        const state = await send<Operation>({ kind: 'prepareMedia', operationId, media })
        if (!state || !validOperation(state) || !state.media
          || Object.entries(media).some(([field, value]) => state.media![field as keyof typeof media] !== value)
          || !Number.isSafeInteger(state.media.writtenBytes) || state.media.writtenBytes < 0 || state.media.writtenBytes > bytes.length) {
          throw new Error('图片上传恢复响应身份无效。')
        }
        prepared = true
        if (state.state === 'committed') {
          if (!validReceipt(state.receipt)) throw new Error('图片上传回执身份无效。')
        } else {
          await uploadArtworkChunks(bytes, state.media.writtenBytes, operationId, 'uploadMediaChunk', send, assertCurrent)
          const receipt = await send<Receipt>({ kind: 'commitMedia', operationId })
          if (!validReceipt(receipt)) throw new Error('图片上传回执身份无效。')
        }
        return handoff()
      } catch (error) {
        // A commit may have succeeded despite a rejected response. Never release or
        // abort on this path; unavailable reconciliation retains the original identity.
        const operation = await send<Operation | null>({ kind: 'getOperation', operationId }).catch(() => null)
        if (prepared && operation && validOperation(operation) && operation.state === 'committed' && validReceipt(operation.receipt)) {
          try { return handoff() } catch { /* Keep the pending identity until handoff can finish. */ }
        }
        throw new PendingMediaUploadError({ operationId, imageId, workspaceId, principalId }, error)
      }
    })
  } finally { stopRuntime() }
}

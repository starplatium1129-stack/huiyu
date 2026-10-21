import type { ArtworkImportAccess, ArtworkImportCommand, ArtworkImportInput, ArtworkImportOutcome } from '../../application/artwork/localImageImport.ts'
import { WorkspaceRequestError } from '../../api/workspace.ts'
import { imageBlobDigest } from '../../utils/imageBlobDigest.ts'
import { parseArtworkRow } from './artworkReadModel.ts'
import { uploadArtworkChunks } from './artworkUploadChunks.ts'
import { rememberWorkspaceMedia, workspaceMediaAuthority } from './workspaceMediaSource.ts'

type Request = <T>(command: Record<string, unknown>) => Promise<T>
interface Operation {
  operationId: string; kind: string; state: 'prepared' | 'committed' | 'aborted'
  media: ArtworkImportInput['media'] & { writtenBytes: number }
  receipt?: { operationId: string; kind: string; revision: number; artwork: unknown }
}

/** The persisted save owns publication and its staging lease, never a temporary alias. */
export async function importDesktopArtwork(input: ArtworkImportInput, command: ArtworkImportCommand,
  access: ArtworkImportAccess, request: Request): Promise<ArtworkImportOutcome> {
  const { check } = access
  check()
  const authority = workspaceMediaAuthority()
  const blob = command.kind === 'save' ? command.blob : undefined
  let verifiedBlob = false, prepared = false
  const send = async <T,>(command: Record<string, unknown>): Promise<T> => { check(); const result = await request<T>(command); check(); return result }
  function validate(raw: Operation) {
    if (!raw || raw.operationId !== input.operationId || raw.kind !== 'saveArtwork'
      || !['prepared', 'committed', 'aborted'].includes(raw.state) || !raw.media
      || Object.entries(input.media).some(([key, value]) => raw.media[key as keyof typeof raw.media] !== value)
      || !Number.isSafeInteger(raw.media.writtenBytes) || raw.media.writtenBytes < 0 || raw.media.writtenBytes > input.media.bytes) {
      throw new Error('图片导入恢复响应身份无效，原记录已保留')
    }
    if (raw.state === 'committed') {
      const receipt = raw.receipt
      const row = receipt && parseArtworkRow(receipt.artwork, input.artwork.id)
      if (!receipt || receipt.operationId !== input.operationId || receipt.kind !== 'saveArtwork'
        || !Number.isSafeInteger(receipt.revision) || receipt.revision < 0 || !row
        || row.body.image_id !== input.media.alias || row.deletedAt !== null) throw new Error('图片导入回执无效，原记录已保留')
    }
    return raw
  }
  async function committed(): Promise<ArtworkImportOutcome> {
    const row = parseArtworkRow(await send({ kind: 'getArtwork', id: input.artwork.id }), input.artwork.id)
    if (!row || row.deletedAt !== null) return 'not-live'
    if (row.body.image_id !== input.media.alias) throw new Error('原作品编号已对应另一张图片，已停止恢复')
    if (blob && verifiedBlob) rememberWorkspaceMedia(blob, input.media, authority)
    return 'saved'
  }
  try {
    // prepareSave checks the complete frozen input, even on terminal replay.
    // A lost prepare response stays pending rather than adopting an unchecked ID.
    const state = validate(await send<Operation>({ kind: 'prepareSave', operationId: input.operationId,
      media: structuredClone(input.media), artwork: structuredClone(input.artwork) }))
    prepared = true
    if (state.state === 'committed') return committed()
    if (state.state === 'aborted') return 'aborted'
    if (command.kind === 'abort') {
      const ended = validate(await send<Operation>({ kind: 'abortSave', operationId: input.operationId }))
      if (ended.state === 'committed') return committed()
      if (ended.state === 'aborted') return 'aborted'
      throw new Error('原导入尚未确认终止，恢复记录已保留')
    }
    if (blob) {
      const digest = await imageBlobDigest(blob, check)
      if (digest.sha256 !== input.media.sha256 || blob.size !== input.media.bytes || blob.type !== input.media.mime)
        throw new Error('所选文件不是原导入图片，请选择原文件；不会另建作品')
      verifiedBlob = true
    }
    if (blob) await uploadArtworkChunks(blob, state.media.writtenBytes, input.operationId, 'uploadChunk', send, check)
    // Even zero staging bytes may have a complete object after an interrupted
    // publication. The server verifies that object before authorizing the commit.
    await send({ kind: 'commitSave', operationId: input.operationId })
    const confirmed = await send<Operation | null>({ kind: 'getOperation', operationId: input.operationId })
    if (!confirmed || validate(confirmed).state !== 'committed') throw new Error('图片导入仍待确认，请重试原导入')
    return committed()
  } catch (error) {
    check()
    // Rejected conflicting inputs cannot adopt an older command's receipt.
    if (!prepared || error instanceof WorkspaceRequestError && error.status >= 400 && error.status < 500 && error.code !== 'COMMIT_UNKNOWN') throw error
    const confirmed = await send<Operation | null>({ kind: 'getOperation', operationId: input.operationId }).catch(() => null)
    check()
    if (confirmed) {
      const terminal = validate(confirmed).state
      if (terminal === 'committed') return committed()
      if (terminal === 'aborted') return 'aborted'
    }
    throw error
  }
}

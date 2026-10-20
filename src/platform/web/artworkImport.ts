import type { ArtworkImportAccess, ArtworkImportCommand, ArtworkImportInput, ArtworkImportOutcome } from '../../application/artwork/localImageImport.ts'
import { imageBlobDigest } from '../../utils/imageBlobDigest.ts'
import { LOCAL_IMAGE_IMPORT_RECEIPT_PREFIX } from '../../utils/storageKeys.ts'
import { assertWebArtworkWritable } from './migrationBarrier.ts'
import { kvGet, kvSetMany } from '../../composables/useKVStore.ts'
import { imgGetRecord, imgPutRecord } from '../../composables/useImageStore.ts'
import { ARTWORK_HISTORY_KEY, ARTWORK_TRASH_KEY, arrayValue, record, recordId, imageId } from './artworkStorage.ts'

/** Runs inside the existing library lock; history and receipt commit together. */
export async function importWebArtwork(input: ArtworkImportInput, command: ArtworkImportCommand, access: ArtworkImportAccess): Promise<ArtworkImportOutcome> {
  const check = () => { access.check(); assertWebArtworkWritable() }
  check()
  const { sha256: inputHash } = await imageBlobDigest(new Blob([JSON.stringify(input)]), check)
  const receiptKey = LOCAL_IMAGE_IMPORT_RECEIPT_PREFIX + input.operationId
  const [historyValue, trashValue, receipt] = await Promise.all([kvGet(ARTWORK_HISTORY_KEY), kvGet(ARTWORK_TRASH_KEY), kvGet(receiptKey)])
  check()
  const history = arrayValue(historyValue), trash = arrayValue(trashValue)
  if (historyValue != null && !history || trashValue != null && !trash)
    throw new Error('原作品或回收站记录无法读取，已停止导入；原数据未改动')
  const records = history ?? []
  const existing = records.find(item => recordId(item) === String(input.artwork.id))
  const expectedReceipt = { operationId: input.operationId, id: input.artwork.id, imageId: input.media.alias, inputHash }
  const savedReceipt = record(receipt)
  if (receipt !== null && receipt !== undefined && (!savedReceipt || !['committed', 'aborted'].includes(String(savedReceipt.state))
    || Object.entries(expectedReceipt).some(([key, value]) => savedReceipt[key] !== value)))
    throw new Error('图片导入回执身份无效，原记录已保留')
  if (existing) {
    if (imageId(existing) !== input.media.alias) throw new Error('原作品编号已对应另一张图片，已停止恢复')
    // Preserve replay knowledge if a recovered publication predates its handoff.
    if (!receipt) { await kvSetMany([{ key: receiptKey, value: { ...expectedReceipt, state: 'committed' } }], check); check() }
    return 'saved'
  }
  if (savedReceipt?.state === 'committed' || (trash ?? []).some(item => recordId(item) === String(input.artwork.id))) return 'not-live'
  if (savedReceipt?.state === 'aborted') return 'aborted'
  if (command.kind === 'abort') {
    await kvSetMany([{ key: receiptKey, value: { ...expectedReceipt, state: 'aborted' } }], check)
    check()
    return 'aborted'
  }
  const stored = await imgGetRecord(input.media.alias)
  check()
  const original = stored?.blob ?? command.blob
  if (!original) throw new Error('原图片尚未保存，请重新选择原文件继续导入')
  const digest = await imageBlobDigest(original, check)
  if (digest.sha256 !== input.media.sha256 || original.size !== input.media.bytes || original.type !== input.media.mime)
    throw new Error('所选文件或原图片与导入记录不一致；原记录已保留，不会另建作品')
  if (!stored) {
    await imgPutRecord({ id: input.media.alias, blob: original, type: input.media.mime, created_at: Number(input.artwork.timestamp) }, check)
    check()
  }
  await kvSetMany([{ key: ARTWORK_HISTORY_KEY, value: [...records, structuredClone(input.artwork)] },
    { key: receiptKey, value: { ...expectedReceipt, state: 'committed' } }], check)
  check()
  return 'saved'
}

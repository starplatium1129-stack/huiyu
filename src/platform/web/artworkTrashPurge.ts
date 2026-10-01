import type { TrashEntry } from '../../application/artwork/artworkRepository.ts'
import { collectImageReferences } from '../../utils/storageReferences.ts'
import { ARTWORK_HISTORY_QUARANTINE_KEY } from '../../utils/storageKeys.ts'
import { thumbKey } from '../../utils/imageThumb.ts'
import { assertArtworkCleanupCurrent, readArtworkCleanupImageReferences } from '../../storage/artworkSession.ts'
import { type ArtworkKvAdapter, type ArtworkImageAdapter, ARTWORK_HISTORY_KEY, ARTWORK_PROJECTS_KEY, ARTWORK_TRASH_KEY, imageId, imageRecordInput, unique, callSafely, ArtworkDeletionError } from './artworkStorage.ts'

/** Called under the same document cleanup lease and library mutation lock. */
export async function purgeWebTrash(kv: ArtworkKvAdapter, images: ArtworkImageAdapter, trash: TrashEntry[], selected: (entry: TrashEntry) => boolean, drafts: unknown[]): Promise<{ purged: number }> {
  const removed = trash.filter(selected)
  if (!removed.length) return { purged: 0 }
  const removedIds = new Set(removed.map(entry => entry.id))
  const surviving = trash.filter(entry => !removedIds.has(entry.id))
  const [history, projects, quarantine] = await Promise.all([
    kv.get(ARTWORK_HISTORY_KEY), kv.get(ARTWORK_PROJECTS_KEY), kv.get(ARTWORK_HISTORY_QUARANTINE_KEY),
  ])
  const protectedIds = collectImageReferences([history, projects, quarantine, surviving, ...drafts, ...readArtworkCleanupImageReferences()])
  // Both the saved exclusive IDs and the restoration snapshot protect shared originals.
  const removable = unique(removed.flatMap(entry => [
    ...(Array.isArray(entry.imageIds) ? entry.imageIds : []), ...entry.historyEntries.map(imageId),
  ])).filter(id => !protectedIds.has(id))
  const originals = await Promise.all(removable.map(id => images.get(id)))
  const thumbnails = new Map(await Promise.all(removable.map(async id => [id, await kv.get(thumbKey(id))] as const)))
  let imagesAttempted = false, thumbnailsAttempted = false, recordsAttempted = false
  try {
    assertArtworkCleanupCurrent()
    if (removable.length) {
      imagesAttempted = true
      await images.deleteMany(removable)
      thumbnailsAttempted = true
      for (const id of removable) await kv.remove?.(thumbKey(id))
    }
    assertArtworkCleanupCurrent()
    recordsAttempted = true
    await kv.set(ARTWORK_TRASH_KEY, surviving)
    return { purged: removed.length }
  } catch (error) {
    const failures: unknown[] = []
    if (imagesAttempted) for (const original of originals) {
      if (original) await callSafely(() => images.putRecord(imageRecordInput(original)).then(() => {}), failures)
    }
    if (thumbnailsAttempted) for (const [id, thumbnail] of thumbnails) {
      await callSafely(() => thumbnail == null ? kv.remove?.(thumbKey(id)) ?? Promise.resolve() : kv.set(thumbKey(id), thumbnail), failures)
    }
    if (recordsAttempted) await callSafely(() => kv.set(ARTWORK_TRASH_KEY, trash), failures)
    throw new ArtworkDeletionError(error, failures, '回收站清理')
  }
}

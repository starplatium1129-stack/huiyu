import type { ArtworkDeleteResult } from '../../application/artwork/artworkRepository.ts'
import type { StoredImageRecord } from '../../composables/useImageStore.ts'
import { thumbKey } from '../../utils/imageThumb.ts'
import { type ArtworkKvAdapter, type ArtworkImageAdapter, ARTWORK_HISTORY_KEY, ARTWORK_PROJECTS_KEY, comparableId, arrayValue, recordId, removeProjectReferences, unique, imageId, imageRecordInput, callSafely, ArtworkDeletionError } from './artworkStorage.ts'

export function createArtworkHardDelete(kv: ArtworkKvAdapter, images: ArtworkImageAdapter) {
  return async function deleteArtworkNow(id: string | number): Promise<ArtworkDeleteResult> {
    const targetId = comparableId(id)
    if (!targetId) throw new Error('作品 ID 无效')

    const [historySnapshot, projectsSnapshot] = await Promise.all([
      kv.get(ARTWORK_HISTORY_KEY),
      kv.get(ARTWORK_PROJECTS_KEY),
    ])
    const history = arrayValue(historySnapshot) ?? []
    const targetEntries = history.filter(item => recordId(item) === targetId)
    const nextHistory = history.filter(item => recordId(item) !== targetId)
    const historyChanged = targetEntries.length > 0
    const projectUpdate = removeProjectReferences(projectsSnapshot, targetId)

    const targetImageIds = unique(targetEntries.map(imageId))
    const remainingImageIds = new Set(unique(nextHistory.map(imageId)))
    const removedImageIds = targetImageIds.filter(image => !remainingImageIds.has(image))
    const removedThumbnailIds = removedImageIds.slice()

    if (!historyChanged && !projectUpdate.changed) {
      return {
        deleted: false,
        historyChanged: false,
        removedImageIds: [],
        removedThumbnailIds: [],
        removedProjectReferences: 0,
      }
    }

    const imageSnapshot = (await Promise.all(removedImageIds.map(image => images.get(image))))
      .filter((item): item is StoredImageRecord => item !== null)
    const thumbnailSnapshot = new Map<string, unknown>()
    for (const image of removedThumbnailIds) {
      thumbnailSnapshot.set(image, await kv.get(thumbKey(image)))
    }

    let historyWriteAttempted = false
    let projectWriteAttempted = false
    let imageDeleteAttempted = false
    let thumbnailDeleteAttempted = false

    try {
      if (historyChanged) {
        historyWriteAttempted = true
        await kv.set(ARTWORK_HISTORY_KEY, nextHistory)
      }
      if (projectUpdate.changed) {
        projectWriteAttempted = true
        await kv.set(ARTWORK_PROJECTS_KEY, projectUpdate.value)
      }
      if (removedImageIds.length) {
        imageDeleteAttempted = true
        await images.deleteMany(removedImageIds)
      }
      if (removedThumbnailIds.length) {
        thumbnailDeleteAttempted = true
        for (const image of removedThumbnailIds) await kv.remove?.(thumbKey(image))
      }
      return {
        deleted: historyChanged,
        historyChanged,
        removedImageIds,
        removedThumbnailIds,
        removedProjectReferences: projectUpdate.removed,
      }
    } catch (originalError) {
      const rollbackErrors: unknown[] = []
      if (imageDeleteAttempted) {
        for (const snapshot of imageSnapshot) {
          await callSafely(() => images.putRecord(imageRecordInput(snapshot)).then(() => undefined), rollbackErrors)
        }
      }
      if (thumbnailDeleteAttempted) {
        for (const [image, snapshot] of thumbnailSnapshot) {
          await callSafely(async () => {
            if (snapshot == null) await kv.remove?.(thumbKey(image))
            else await kv.set(thumbKey(image), snapshot)
          }, rollbackErrors)
        }
      }
      if (projectWriteAttempted) {
        await callSafely(() => kv.set(ARTWORK_PROJECTS_KEY, projectsSnapshot), rollbackErrors)
      }
      if (historyWriteAttempted) {
        await callSafely(() => kv.set(ARTWORK_HISTORY_KEY, historySnapshot), rollbackErrors)
      }
      throw new ArtworkDeletionError(originalError, rollbackErrors)
    }
  }

}

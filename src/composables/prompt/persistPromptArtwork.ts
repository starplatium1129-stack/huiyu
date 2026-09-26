import { artworkRepository } from '@/storage/artworkRepository'
import { normalizeArtistStyleIds } from '@/config/artistStyles'
import { saveArtworkSnapshot } from '@/application/artwork/saveGeneratedArtwork'
import type { ArtworkSaveSnapshot } from '@/application/artwork/artworkSaveInput'
import type { usePromptHistoryStore } from '@/stores/promptHistoryStore'

/** Save-only adapters load on first save; the submitted snapshot already exists. */
export async function persistPromptArtwork(snapshot: ArtworkSaveSnapshot, historyStore: ReturnType<typeof usePromptHistoryStore>) {
  const repository = artworkRepository
  const result = await saveArtworkSnapshot(snapshot, {
    withStaging: work => repository.withStaging(async () => {
      const saved = await work()
      if (saved.ok) historyStore.history = saved.history
      else console.warn('commitHistoryEntry failed', { error: saved.error, operationId: saved.operationId, cleanup: saved.cleanup })
      return saved
    }),
    putImage: blob => repository.putImage(blob), deleteImage: id => repository.deleteImage(id),
    cacheThumbnail: (id, blob) => repository.cacheThumbnail(id, blob), measureBlob: historyStore.measureBlob,
    now: () => Date.now(), nextId: historyStore.historyIdSeq,
    readArtworkHistory: () => repository.readHistory(),
    normalizeArtistStyleIds, appendArtwork: entry => repository.appendArtwork(entry),
  })
  if (!result.ok && result.cleanup.status === 'commit-unknown') {
    try {
      const { useToast } = await import('@/composables/useToast')
      useToast().show('保存结果暂时无法确认，原图已保留。请先到作品册核对，再决定是否重新保存。', 'warning')
    } catch { /* Optional feedback cannot change the persistence outcome. */ }
  }
  return result.ok ? result.entry : null
}

import { artworkRepository } from '@/storage/artworkRepository'
import { normalizeArtistStyleIds } from '@/config/artistStyles'
import { saveArtworkSnapshot } from '@/application/artwork/saveGeneratedArtwork'
import type { ArtworkSaveSnapshot } from '@/application/artwork/artworkSaveInput'
import type { usePromptHistoryStore } from '@/stores/promptHistoryStore'
import { archiveTaskResult } from '@/composables/tasks/taskArtwork'
import { taskResultHistory } from '@/application/artwork/taskResultHistory'

/** Save-only adapters load on first save; the submitted snapshot already exists. */
export async function persistPromptArtwork(snapshot: ArtworkSaveSnapshot, historyStore: ReturnType<typeof usePromptHistoryStore>) {
  const repository = artworkRepository
  if (snapshot.entry.taskId) {
    const entry = await archiveTaskResult(snapshot.entry.taskId, snapshot.entry.resultIndex ?? 0)
    historyStore.rememberArtwork(entry)
    return taskResultHistory(entry)
  }
  const result = await saveArtworkSnapshot(snapshot, {
    withStaging: work => repository.withStaging(async () => {
      const saved = await work()
      if (saved.ok) historyStore.rememberArtwork(saved.entry)
      else console.warn('commitHistoryEntry failed', { error: saved.error, operationId: saved.operationId, cleanup: saved.cleanup })
      return saved
    }),
    putImage: blob => repository.putImage(blob), deleteImage: id => repository.deleteImage(id),
    cacheThumbnail: (id, blob) => repository.cacheThumbnail(id, blob), measureBlob: historyStore.measureBlob,
    now: () => Date.now(), nextId: historyStore.historyIdSeq,
    readArtwork: id => repository.readArtwork(id),
    normalizeArtistStyleIds, appendArtwork: entry => repository.appendArtwork(entry),
  })
  if (!result.ok && ['commit-unknown', 'upload-pending'].includes(result.cleanup.status)) {
    try {
      const { useToast } = await import('@/composables/useToast')
      useToast().show(result.cleanup.status === 'upload-pending'
        ? '图片上传尚未确认，恢复标记已保留。连接恢复后请重试保存同一张图片。'
        : '保存结果暂时无法确认，原图已保留。请先到作品册核对，再决定是否重新保存。', 'warning')
    } catch { /* Optional feedback cannot change the persistence outcome. */ }
  }
  return result.ok ? result.entry : null
}

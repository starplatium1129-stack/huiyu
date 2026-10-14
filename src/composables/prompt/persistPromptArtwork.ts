import { artworkRepository, type ArtworkRepository } from '@/storage/artworkRepository'
import { getDesktopRuntime } from '@/platform/desktop/runtime'
import { normalizeArtistStyleIds } from '@/config/artistStyles'
import { saveArtworkSnapshot } from '@/application/artwork/saveGeneratedArtwork'
import type { ArtworkSaveSnapshot } from '@/application/artwork/artworkSaveInput'
import type { usePromptHistoryStore } from '@/stores/promptHistoryStore'
import { archiveTaskResult } from '@/composables/tasks/taskArtwork'
import { taskResultHistory } from '@/application/artwork/taskResultHistory'

/** Save-only adapters load on first save; the submitted snapshot already exists. */
export async function persistPromptArtwork(snapshot: ArtworkSaveSnapshot, historyStore: ReturnType<typeof usePromptHistoryStore>,
  repository: ArtworkRepository = artworkRepository, expectedAuthority?: string) {
  const authority = () => {
    const workspace = getDesktopRuntime().bootstrap?.runtime?.workspace
    return JSON.stringify([workspace?.workspaceId, workspace?.principalId])
  }
  const expected = expectedAuthority ?? authority()
  const current = () => repository === artworkRepository && authority() === expected
  const check = () => { if (!current()) throw new Error('作品库身份已变化，请回到原工作区保存这张图片') }
  check()
  if (snapshot.entry.taskId) {
    const entry = await archiveTaskResult(snapshot.entry.taskId, snapshot.entry.resultIndex ?? 0, repository)
    if (current()) historyStore.rememberArtwork(entry)
    return taskResultHistory(entry)
  }
  const result = await saveArtworkSnapshot(snapshot, {
    withStaging: work => repository.withStaging(async () => {
      check()
      const saved = await work()
      if (saved.ok) { if (current()) historyStore.rememberArtwork(saved.entry) }
      else console.warn('commitHistoryEntry failed', { error: saved.error, operationId: saved.operationId, cleanup: saved.cleanup })
      return saved
    }),
    putImage: blob => { check(); return repository.putImage(blob) }, deleteImage: id => { check(); return repository.deleteImage(id) },
    cacheThumbnail: async (id, blob) => { check(); return repository.cacheThumbnail(id, blob) }, measureBlob: historyStore.measureBlob,
    now: () => Date.now(), nextId: historyStore.historyIdSeq,
    readArtwork: id => { check(); return repository.readArtwork(id) },
    normalizeArtistStyleIds, appendArtwork: entry => { check(); return repository.appendArtwork(entry) },
  })
  if (!result.ok && ['commit-unknown', 'identity-pending', 'upload-pending'].includes(result.cleanup.status)) {
    try {
      const { useToast } = await import('@/composables/useToast')
      useToast().show(result.cleanup.status === 'identity-pending'
        ? result.error instanceof Error ? result.error.message : '入册身份尚未写稳，尚未提交；请恢复连接后重试同一张图片。'
        : result.cleanup.status === 'upload-pending'
        ? '图片上传尚未确认，恢复标记已保留。连接恢复后请重试保存同一张图片。'
        : '保存结果暂时无法确认，原图已保留。请先到作品册核对，再决定是否重新保存。', 'warning')
    } catch { /* Optional feedback cannot change the persistence outcome. */ }
  }
  return result.ok ? result.entry : null
}

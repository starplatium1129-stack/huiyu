import { withArtworkStaging } from '@/storage/artworkSession'
import { prepareGeneratedArtwork, type GeneratedArtworkInput, type LegacyArtworkDefaults } from '@/application/artwork/artworkSaveInput'
import { imgPut, imgDelete } from '@/composables/useImageStore'
import { artworkRepository } from '@/storage/artworkRepository'
import { usePromptHistoryStore } from '@/stores/promptHistoryStore'
import { normalizeArtistStyleIds } from '@/config/artistStyles'
import { storeToRefs } from 'pinia'
import type { HistoryEntry } from '@/types/promptHistory'

/** Storage adapter: the use case owns saving, historyStore owns publication. */
export function usePromptArtworkHistory(resolveLegacyArtworkDefaults: (entry: GeneratedArtworkInput) => LegacyArtworkDefaults) {
  const historyStore = usePromptHistoryStore()
  const { history, projects } = storeToRefs(historyStore)
  async function commitHistoryEntry(entry: GeneratedArtworkInput): Promise<HistoryEntry | null> {
    const snapshot = prepareGeneratedArtwork(entry, resolveLegacyArtworkDefaults)
    const { saveArtworkSnapshot } = await import('@/application/artwork/saveGeneratedArtwork')
    const result = await saveArtworkSnapshot(snapshot, {
      withStaging: work => withArtworkStaging(async () => {
        const saved = await work()
        // Keep page publication inside the existing staging lease, after persistence.
        if (saved.ok) history.value = saved.history
        else console.warn('commitHistoryEntry failed', saved.error)
        return saved
      }),
      putImage: imgPut, deleteImage: imgDelete,
      cacheThumbnail: historyStore.cacheThumbnail, measureBlob: historyStore.measureBlob,
      now: () => Date.now(), nextId: historyStore.historyIdSeq,
      normalizeArtistStyleIds, appendArtwork: artworkRepository.appendArtwork,
    })
    return result.ok ? result.entry : null
  }

  async function removeHistoryEntry(id: string | number) {
    await historyStore.removeHistoryEntry(id)
  }

  /** 撤销软删（2026-08-30 UX 审计 P0-8）：整条恢复并重载列表。 */
  async function restoreHistoryEntry(id: string | number): Promise<boolean> {
    return await historyStore.restoreHistoryEntry(id)
  }

  async function loadHistory() {
    await historyStore.loadHistory()
  }

  async function loadProjects() {
    await historyStore.loadProjects()
  }


  return { history, projects, commitHistoryEntry, removeHistoryEntry, restoreHistoryEntry, loadHistory, loadProjects }
}

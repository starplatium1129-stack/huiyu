import { prepareGeneratedArtwork, type GeneratedArtworkInput, type LegacyArtworkDefaults } from '@/application/artwork/artworkSaveInput'
import { usePromptHistoryStore } from '@/stores/promptHistoryStore'
import { storeToRefs } from 'pinia'
import type { HistoryEntry } from '@/types/promptHistory'

/** Storage adapter: the use case owns saving, historyStore owns publication. */
export function usePromptArtworkHistory(resolveLegacyArtworkDefaults: (entry: GeneratedArtworkInput) => LegacyArtworkDefaults) {
  const historyStore = usePromptHistoryStore()
  const { history, projects } = storeToRefs(historyStore)
  async function commitHistoryEntry(entry: GeneratedArtworkInput): Promise<HistoryEntry | null> {
    const snapshot = prepareGeneratedArtwork(entry, resolveLegacyArtworkDefaults)
    const { persistPromptArtwork } = await import('./persistPromptArtwork')
    return persistPromptArtwork(snapshot, historyStore)
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

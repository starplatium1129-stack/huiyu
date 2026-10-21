import { prepareGeneratedArtwork, type GeneratedArtworkInput, type LegacyArtworkDefaults } from '@/application/artwork/artworkSaveInput'
import { usePromptHistoryStore } from '@/stores/promptHistoryStore'
import { storeToRefs } from 'pinia'
import type { HistoryEntry } from '@/types/promptHistory'
import { artworkRepository, type ArtworkRepository } from '@/storage/artworkRepository'
import { getDesktopRuntime } from '@/platform/desktop/runtime'
import type { ArtworkSaveSnapshot } from '@/application/artwork/artworkSaveInput'

/** Storage adapter: the use case owns saving, historyStore owns publication. */
export function usePromptArtworkHistory(resolveLegacyArtworkDefaults: (entry: GeneratedArtworkInput) => LegacyArtworkDefaults) {
  const historyStore = usePromptHistoryStore()
  const { history, historyLoading, historyError } = storeToRefs(historyStore)
  const owners = new WeakMap<ArtworkSaveSnapshot, { repository: ArtworkRepository; authority: string }>()
  async function commitHistoryEntry(entry: GeneratedArtworkInput, repository: ArtworkRepository = artworkRepository): Promise<HistoryEntry | null> {
    const workspace = getDesktopRuntime().bootstrap?.runtime?.workspace
    const authority = JSON.stringify([workspace?.workspaceId, workspace?.principalId])
    const snapshot = prepareGeneratedArtwork(entry, resolveLegacyArtworkDefaults)
    const owner = owners.get(snapshot) ?? { repository, authority }
    owners.set(snapshot, owner)
    const { persistPromptArtwork } = await import('./persistPromptArtwork')
    return persistPromptArtwork(snapshot, historyStore, owner.repository, owner.authority)
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

  return { history, historyLoading, historyError, readHistoryEntry: historyStore.readHistoryEntry, commitHistoryEntry, removeHistoryEntry, restoreHistoryEntry, loadHistory }
}

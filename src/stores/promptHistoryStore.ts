import { ref } from 'vue'
import { defineStore } from 'pinia'
import { artworkRepository } from '@/storage/artworkRepository'
import { artworkTimestamp, parseArtworkRecords, type ArtworkRecord } from '@/types/artwork'

let lastHistoryId = 0
function historyIdSeq(now: number): number {
  lastHistoryId = Math.max(now * 1000, lastHistoryId) + 1
  return lastHistoryId
}

export const usePromptHistoryStore = defineStore('promptHistory', () => {
  const history = ref<ArtworkRecord[]>([])
  let historyLoad = 0

  function rememberArtwork(entry: ArtworkRecord) {
    // A pre-save load cannot overwrite a newly confirmed entry with an older snapshot.
    historyLoad += 1
    history.value = [...history.value.filter(item => String(item.id).trim() !== String(entry.id).trim()), structuredClone(entry)]
      .sort((a, b) => artworkTimestamp(b) - artworkTimestamp(a))
  }

  async function loadHistory() {
    const request = ++historyLoad
    try {
      const raw = await artworkRepository.readHistory()
      if (request === historyLoad) history.value = parseArtworkRecords(raw)
    } catch {}
  }

  /**
   * 移除一条历史作品（2026-08-30 UX 审计 P0-8）。
   *
   * 改走软删：条目与项目引用立即消失（界面反馈与从前一致），原图与缩略图
   * 保留 30 天，期间 restoreHistoryEntry 可整条恢复。历史面板与作品册两条
   * 删除路径共用同一实现，避免「这边可撤销、那边不可」的割裂。
   */
  async function removeHistoryEntry(id: number | string) {
    const result = await artworkRepository.softDeleteArtwork(id)
    if (result.deleted) {
      historyLoad += 1
      history.value = parseArtworkRecords(history.value).filter(entry => String(entry.id).trim() !== String(id).trim())
    }
  }

  /** 撤销软删：整条恢复并重新载入列表。 */
  async function restoreHistoryEntry(id: number | string): Promise<boolean> {
    const result = await artworkRepository.restoreArtwork(id)
    if (!result.restored) return false
    await loadHistory()
    return true
  }

  return {
    history,
    historyIdSeq,
    loadHistory,
    rememberArtwork,
    removeHistoryEntry,
    restoreHistoryEntry,
  }
})

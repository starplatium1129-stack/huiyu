import { onScopeDispose, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import { artworkRepository } from '@/storage/artworkRepository'
import { artworkTimestamp, parseArtworkRecords, type ArtworkRecord } from '@/types/artwork'
import { imageMediaSession } from '@/platform/imageMediaSession'
import { onDesktopRuntime } from '@/platform/desktop/runtime'

let lastHistoryId = 0
function historyIdSeq(now: number): number {
  lastHistoryId = Math.max(now * 1000, lastHistoryId) + 1
  return lastHistoryId
}

export const usePromptHistoryStore = defineStore('promptHistory', () => {
  const history = shallowRef<ArtworkRecord[]>([])
  const historyLoading = ref(false), historyError = ref('')
  let historyLoad = 0
  let controller: AbortController | undefined
  let source = imageMediaSession()
  function cancelRead() { historyLoad++; controller?.abort(); controller = undefined; historyLoading.value = false }
  function refreshSource() {
    if (source === imageMediaSession()) return
    source = imageMediaSession(); cancelRead(); history.value = []; historyError.value = ''
  }
  const stopRuntime = onDesktopRuntime(refreshSource)
  watch(imageMediaSession, refreshSource, { flush: 'sync' })
  onScopeDispose(() => { cancelRead(); stopRuntime() })

  function rememberArtwork(entry: ArtworkRecord) {
    // A pre-save load cannot overwrite a newly confirmed entry with an older snapshot.
    refreshSource(); cancelRead()
    history.value = [...history.value.filter(item => String(item.id).trim() !== String(entry.id).trim()), structuredClone(entry)]
      .sort((a, b) => artworkTimestamp(b) - artworkTimestamp(a)).slice(0, 12)
  }

  async function loadHistory() {
    refreshSource(); cancelRead()
    const request = ++historyLoad
    const repository = artworkRepository, session = imageMediaSession(), abort = new AbortController()
    controller = abort; historyLoading.value = true; historyError.value = ''
    const current = () => request === historyLoad && !abort.signal.aborted && repository === artworkRepository && session === imageMediaSession()
    try {
      const raw = await repository.readRecentHistory(abort.signal, 12)
      if (current()) history.value = parseArtworkRecords(raw)
    } catch {
      if (current()) historyError.value = '最近作品暂时无法读取，请重试。'
    } finally { if (current()) { historyLoading.value = false; controller = undefined } }
  }

  async function readHistoryEntry(id: string | number) {
    const repository = artworkRepository, session = imageMediaSession()
    const entry = await repository.readArtwork(id)
    if (repository !== artworkRepository || session !== imageMediaSession()) throw new Error('作品库连接已变化，请重新读取')
    return entry
  }

  /**
   * 移除一条历史作品（2026-08-30 UX 审计 P0-8）。
   *
   * 改走软删：条目与项目引用立即消失（界面反馈与从前一致），原图与缩略图
   * 保留 30 天，期间 restoreHistoryEntry 可整条恢复。历史面板与作品册两条
   * 删除路径共用同一实现，避免「这边可撤销、那边不可」的割裂。
   */
  async function removeHistoryEntry(id: number | string) {
    const repository = artworkRepository, session = imageMediaSession()
    const result = await repository.softDeleteArtwork(id)
    if (result.deleted && repository === artworkRepository && session === imageMediaSession()) {
      cancelRead()
      history.value = parseArtworkRecords(history.value).filter(entry => String(entry.id).trim() !== String(id).trim())
      void loadHistory()
    }
  }

  /** 撤销软删：整条恢复并重新载入列表。 */
  async function restoreHistoryEntry(id: number | string): Promise<boolean> {
    const repository = artworkRepository, session = imageMediaSession()
    const result = await repository.restoreArtwork(id)
    if (!result.restored) return false
    if (repository === artworkRepository && session === imageMediaSession()) await loadHistory()
    return true
  }

  return {
    history, historyLoading, historyError, readHistoryEntry,
    historyIdSeq,
    loadHistory,
    rememberArtwork,
    removeHistoryEntry,
    restoreHistoryEntry,
  }
})

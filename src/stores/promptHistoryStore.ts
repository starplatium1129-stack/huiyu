import { ref } from 'vue'
import { defineStore } from 'pinia'
import { kvGet, kvSet } from '@/composables/useKVStore'
import { blobThumbDataUrl, thumbKey } from '@/utils/imageThumb'
import { artworkRepository } from '@/storage/artworkRepository'
import { ARTWORK_HISTORY_KV_KEY, ARTWORK_PROJECTS_KV_KEY } from '@/utils/storageKeys'
import { parseProjectOptions, type ProjectOption } from '@/utils/promptBuilderPersistence'
import { parseArtworkRecords, type ArtworkRecord } from '@/types/artwork'

const HISTORY_STORAGE_KEY = ARTWORK_HISTORY_KV_KEY
const PROJECT_STORAGE_KEY = ARTWORK_PROJECTS_KV_KEY

let lastHistoryId = 0
function historyIdSeq(now: number): number {
  lastHistoryId = Math.max(now * 1000, lastHistoryId) + 1
  return lastHistoryId
}

async function measureBlob(blob: Blob): Promise<{ width: number | null; height: number | null }> {
  try {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob)
      const size = { width: bitmap.width, height: bitmap.height }
      bitmap.close?.()
      return size
    }
  } catch { /* fallback */ }
  return await new Promise(resolve => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => { resolve({ width: img.naturalWidth || null, height: img.naturalHeight || null }); URL.revokeObjectURL(url) }
    img.onerror = () => { resolve({ width: null, height: null }); URL.revokeObjectURL(url) }
    img.src = url
  })
}

async function cacheThumbnail(imageId: string, blob: Blob): Promise<void> {
  try {
    const dataUrl = await blobThumbDataUrl(blob)
    if (dataUrl) await kvSet(thumbKey(imageId), dataUrl)
  } catch { /* ignore */ }
}

export const usePromptHistoryStore = defineStore('promptHistory', () => {
  const history = ref<ArtworkRecord[]>([])
  const projects = ref<ProjectOption[]>([])
  let historyLoad = 0
  let projectLoad = 0

  async function loadHistory() {
    const request = ++historyLoad
    try {
      const raw = await kvGet<unknown[]>(HISTORY_STORAGE_KEY)
      if (request === historyLoad) history.value = parseArtworkRecords(raw)
    } catch {}
    await loadProjects()
  }

  async function loadProjects() {
    const request = ++projectLoad
    try {
      let raw: unknown = await kvGet(PROJECT_STORAGE_KEY)
      let parsed = parseProjectOptions(raw)
      if (!Array.isArray(raw)) {
        raw = await kvGet('aics_projects')
        parsed = parseProjectOptions(raw)
      }
      if (request === projectLoad) projects.value = parsed
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
      await loadProjects()
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
    projects,
    historyIdSeq,
    measureBlob,
    cacheThumbnail,
    loadHistory,
    loadProjects,
    removeHistoryEntry,
    restoreHistoryEntry,
  }
})

export type PromptHistoryStore = ReturnType<typeof usePromptHistoryStore>

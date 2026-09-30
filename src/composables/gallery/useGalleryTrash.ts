import { artworkRepository } from '@/storage/artworkRepository'
import type { useGalleryWorkspace } from './useGalleryWorkspace'
type Context = Pick<ReturnType<typeof useGalleryWorkspace>, "trashItems" | "trashThumbs" | "trashBusy" | "showToast" | "loadGalleryStorage">
export function useGalleryTrash({ trashItems, trashThumbs, trashBusy, showToast, loadGalleryStorage }: Context): { loadTrash: () => Promise<void>; restoreTrashItem: (id: string | number) => Promise<void> } {
let loadVersion = 0
let restoreVersion = 0
let publishedIds = new Set<string | number>()
async function loadTrash() {
  const version = ++loadVersion
  const restoration = restoreVersion
  try {
    const entries = await artworkRepository.listTrash()
    if (version !== loadVersion || restoration !== restoreVersion) return
    entries.sort((a, b) => Number(b.deletedAt) - Number(a.deletedAt))
    trashItems.value = entries
    const ids = publishedIds = new Set<string | number>(entries.map(entry => entry.id))
    for (const entry of entries) {
      if (version !== loadVersion) return
      if (!ids.has(entry.id)) continue
      const imageId = entry.imageIds?.[0]
      if (!imageId || trashThumbs[entry.id]) continue
      const thumb = await artworkRepository.getThumbnail(imageId)
      if (version !== loadVersion) return
      if (thumb && ids.has(entry.id)) trashThumbs[entry.id] = thumb
    }
  } catch (e) {
    console.warn('[gallery] load trash failed', e)
  }
}

async function restoreTrashItem(id: string | number) {
  if (trashBusy.value !== null) return
  trashBusy.value = id
  try {
    const result = await artworkRepository.restoreArtwork(id)
    if (result.restored) {
      // Reject pre-restore lists, but let published lists hydrate remaining items.
      restoreVersion++
      publishedIds.delete(id)
      showToast('已恢复，放回展墙', 'success')
      trashItems.value = trashItems.value.filter(entry => entry.id !== id)
      delete trashThumbs[id]
      await loadGalleryStorage()
    } else {
      showToast(result.missingImageIds?.length
        ? '原图已缺失，无法完整恢复；回收站快照仍保留'
        : '这条作品已不在回收站，无法恢复', 'warning')
      await loadTrash()
    }
  } catch (e) {
    console.warn('[gallery] restore trash failed', e)
    showToast('恢复失败，请重试', 'warning')
  } finally {
    trashBusy.value = null
  }
}
return { loadTrash, restoreTrashItem }
}

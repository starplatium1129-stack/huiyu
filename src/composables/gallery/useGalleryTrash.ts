import { kvGet } from '@/composables/useKVStore'
import { artworkRepository } from '@/storage/artworkRepository'
import { thumbKey } from '@/utils/imageThumb'
import type { useGalleryWorkspace } from './useGalleryWorkspace'
type Context = Pick<ReturnType<typeof useGalleryWorkspace>, "trashItems" | "trashThumbs" | "trashBusy" | "showToast" | "loadGalleryStorage">
export function useGalleryTrash({ trashItems, trashThumbs, trashBusy, showToast, loadGalleryStorage }: Context): { loadTrash: () => Promise<void>; restoreTrashItem: (id: string | number) => Promise<void> } {
async function loadTrash() {
  try {
    const entries = await artworkRepository.listTrash()
    entries.sort((a, b) => Number(b.deletedAt) - Number(a.deletedAt))
    trashItems.value = entries
    for (const entry of entries) {
      const imageId = entry.imageIds?.[0]
      if (!imageId || trashThumbs[entry.id]) continue
      const thumb = await kvGet<string>(thumbKey(imageId))
      if (thumb) trashThumbs[entry.id] = thumb
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

import { onActivated, onDeactivated, onUnmounted, ref, watch, type Ref } from 'vue'
import { artworkRepository } from '@/storage/artworkRepository'
import { confirmAction } from '@/composables/useConfirm'
import type { useGalleryWorkspace } from './useGalleryWorkspace'
type Context = Pick<ReturnType<typeof useGalleryWorkspace>, "trashMode" | "trashItems" | "trashThumbs" | "trashBusy" | "showToast" | "loadGalleryStorage">
export function useGalleryTrash({ trashMode, trashItems, trashThumbs, trashBusy, showToast, loadGalleryStorage }: Context): { loadTrash: () => Promise<void>; restoreTrashItem: (id: string | number) => Promise<void>; clearTrash: () => Promise<void>; trashClearing: Ref<boolean> } {
const trashClearing = ref(false)
let loadVersion = 0
let restoreVersion = 0
let publishedIds = new Set<string | number>()
let active = true
let disposed = false
function invalidateLoads() { loadVersion++ }
onDeactivated(() => { active = false; invalidateLoads() })
onUnmounted(() => { disposed = true; active = false; invalidateLoads() })
onActivated(() => {
  const returning = !active
  active = true
  if (returning && trashMode.value) void loadTrash()
})
// Opening trash is owned by toggleTrashMode; only invalidate on closing here.
watch(trashMode, visible => { if (!visible) invalidateLoads() }, { flush: 'sync' })
async function loadTrash() {
  if (disposed || !active || !trashMode.value || trashClearing.value) return
  const version = ++loadVersion
  const restoration = restoreVersion
  try {
    const entries = await artworkRepository.listTrash()
    if (version !== loadVersion || restoration !== restoreVersion) return
    entries.sort((a, b) => Number(b.deletedAt) - Number(a.deletedAt))
    trashItems.value = entries
    const ids = publishedIds = new Set<string | number>(entries.map(entry => entry.id))
    const keys = new Set(entries.map(entry => String(entry.id)))
    for (const key of Object.keys(trashThumbs)) if (!keys.has(key)) delete trashThumbs[key]
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
  if (trashBusy.value !== null || trashClearing.value) return
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
async function clearTrash() {
  if (disposed || !active || !trashMode.value || trashClearing.value || trashBusy.value !== null || !trashItems.value.length) return
  const entries = trashItems.value.map(({ id, deletedAt }) => ({ id, deletedAt }))
  trashClearing.value = true
  let accepted = false
  try {
    const confirmed = await confirmAction({
      title: `清空回收站中的 ${entries.length} 幅作品？`,
      message: '清空后无法从回收站恢复。仍在其他作品或草稿中使用的图片会保留。',
      confirmLabel: '永久清空', danger: true,
    })
    if (!confirmed || disposed || !active || !trashMode.value) return
    accepted = true
    invalidateLoads()
    restoreVersion++
    const { purged } = await artworkRepository.purgeTrash(entries)
    showToast(purged ? `已永久清理 ${purged} 幅回收站作品` : '回收站已变化，未删除新的作品', purged ? 'success' : 'info')
  } catch (error) {
    console.warn('[gallery] clear trash failed', error)
    showToast('清理未完成，请重新查看回收站后重试', 'warning')
  } finally {
    trashClearing.value = false
    if (accepted) await loadTrash()
  }
}
return { loadTrash, restoreTrashItem, clearTrash, trashClearing }
}

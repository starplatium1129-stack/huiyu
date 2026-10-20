import { onActivated, onDeactivated, onUnmounted, ref, watch, type Ref } from 'vue'
import { artworkRepository } from '@/storage/artworkRepository'
import { confirmAction } from '@/composables/useConfirm'
import { ArtworkMutationUnconfirmedError } from '@/application/artwork/artworkMutationOutcome'
import type { useGalleryWorkspace } from './useGalleryWorkspace'
type Context = Pick<ReturnType<typeof useGalleryWorkspace>, "trashMode" | "trashItems" | "trashBusy" | "showToast" | "loadGalleryStorage">
export function useGalleryTrash({ trashMode, trashItems, trashBusy, showToast, loadGalleryStorage }: Context): { loadTrash: () => Promise<void>; restoreTrashItem: (id: string | number) => Promise<void>; clearTrash: () => Promise<void>; trashClearing: Ref<boolean>; trashLoading: Ref<boolean>; trashError: Ref<string> } {
const trashClearing = ref(false)
const trashLoading = ref(false), trashError = ref('')
let loadVersion = 0
let restoreVersion = 0
let viewRevision = 0
let active = true
let disposed = false
function invalidateLoads() { loadVersion++; trashLoading.value = false }
function invalidateView() { viewRevision++; invalidateLoads() }
onDeactivated(() => { active = false; invalidateView() })
onUnmounted(() => { disposed = true; active = false; invalidateView() })
onActivated(() => {
  const returning = !active
  active = true
  if (returning && trashMode.value) void loadTrash()
})
// Opening trash is owned by toggleTrashMode; only invalidate on closing here.
watch(trashMode, visible => { if (!visible) invalidateView() }, { flush: 'sync' })
async function loadTrash() {
  if (disposed || !active || !trashMode.value || trashClearing.value) return
  const version = ++loadVersion
  const restoration = restoreVersion
  trashLoading.value = true
  trashError.value = ''
  try {
    const entries = await artworkRepository.listTrash()
    if (version !== loadVersion || restoration !== restoreVersion) return
    entries.sort((a, b) => Number(b.deletedAt) - Number(a.deletedAt))
    trashItems.value = entries
    trashLoading.value = false
  } catch (e) {
    if (version === loadVersion && restoration === restoreVersion) trashError.value = '暂时无法读取回收站，请重新读取；已有作品不会因此被删除。'
    console.warn('[gallery] load trash failed', e)
  } finally {
    if (version === loadVersion) trashLoading.value = false
  }
}

async function restoreTrashItem(id: string | number) {
  if (trashBusy.value !== null || trashClearing.value) return
  trashBusy.value = id
  try {
    const result = await artworkRepository.restoreArtwork(id)
    if (result.restored) {
      // A list started before this restore must not republish the removed entry.
      restoreVersion++
      showToast('已恢复，放回展墙', 'success')
      trashItems.value = trashItems.value.filter(entry => entry.id !== id)
      await loadGalleryStorage()
    } else {
      showToast(result.missingImageIds?.length
        ? '原图已缺失，无法完整恢复；回收站快照仍保留'
        : '这条作品已不在回收站，无法恢复', 'warning')
      await loadTrash()
    }
  } catch (e) {
    console.warn('[gallery] restore trash failed', e)
    if (e instanceof ArtworkMutationUnconfirmedError) {
      showToast('恢复结果尚未确认，正在重新读取；请核对展墙和回收站后再操作', 'warning')
      restoreVersion++
      await Promise.all([loadGalleryStorage(), loadTrash()])
    } else showToast('恢复失败，请重试', 'warning')
  } finally {
    trashBusy.value = null
  }
}
async function clearTrash() {
  if (disposed || !active || !trashMode.value || trashClearing.value || trashBusy.value !== null || !trashItems.value.length) return
  const revision = viewRevision
  const entries = trashItems.value.map(({ id, deletedAt }) => ({ id, deletedAt }))
  trashClearing.value = true
  let accepted = false
  try {
    const confirmed = await confirmAction({
      title: `清空回收站中的 ${entries.length} 幅作品？`,
      message: '清空后无法从回收站恢复。仍在其他作品或草稿中使用的图片会保留。',
      confirmLabel: '永久清空', danger: true,
    })
    if (!confirmed || disposed || !active || !trashMode.value || revision !== viewRevision) return
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
    if (accepted || revision !== viewRevision) await loadTrash()
  }
}
return { loadTrash, restoreTrashItem, clearTrash, trashClearing, trashLoading, trashError }
}

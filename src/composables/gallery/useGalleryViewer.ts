import { computed, onDeactivated, onUnmounted, ref, watch, type Ref } from 'vue'
import { artworkRepository } from '@/storage/artworkRepository'
import type { ArtworkRecord } from '@/types/artwork'
import { artworkIndexById, safeImageUrl } from './galleryHelpers'

/** Gallery owns the image until its enclosing transition actually finishes. */
export function useGalleryViewer(options: {
  history: Ref<ArtworkRecord[]>
  visible: Ref<ArtworkRecord[]>
  resetControls: () => void
}) {
  const viewerIndex = ref(-1)
  const viewerItemId = ref<string | number | null>(null)
  const viewerUrl = ref('')
  const current = computed(() => {
    const index = artworkIndexById(options.history.value, viewerItemId.value)
    return index >= 0 ? options.history.value[index] : null
  })
  let objectUrl = ''
  let loadToken = 0
  let disposed = false

  function releaseImage() {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = ''
    viewerUrl.value = ''
  }

  async function hydrate(item: ArtworkRecord) {
    releaseImage()
    const token = ++loadToken
    const fallback = safeImageUrl(item.image_url)
    try {
      const blob = item.image_id ? await artworkRepository.getImage(item.image_id) : null
      if (disposed || token !== loadToken || current.value?.id !== item.id) return
      if (blob) {
        objectUrl = URL.createObjectURL(blob)
        viewerUrl.value = objectUrl
      } else if (fallback) viewerUrl.value = fallback
      else if (item.image_data?.startsWith('data:image/')) viewerUrl.value = item.image_data
    } catch {
      if (!disposed && token === loadToken) viewerUrl.value = ''
    }
  }

  function openViewer(index: number) {
    const item = options.visible.value[index]
    if (disposed || !item) return
    const reuseImage = viewerItemId.value === item.id && Boolean(viewerUrl.value)
    viewerItemId.value = item.id
    viewerIndex.value = index
    options.resetControls()
    if (!reuseImage) void hydrate(item)
  }

  function closeViewer() {
    loadToken++
    viewerIndex.value = -1
    // Keep image, comparison and metadata intact while the surface leaves.
  }

  function onViewerClosed() {
    // A reversed leave must never clear the image of the reopened viewer.
    if (viewerIndex.value >= 0) return
    viewerItemId.value = null
    releaseImage()
    options.resetControls()
  }

  function step(delta: number) {
    const next = artworkIndexById(options.visible.value, viewerItemId.value) + delta
    if (viewerIndex.value >= 0 && next >= 0 && next < options.visible.value.length) openViewer(next)
  }

  watch(options.visible, () => {
    if (viewerIndex.value < 0) return
    const index = artworkIndexById(options.visible.value, viewerItemId.value)
    if (index < 0) closeViewer()
    else viewerIndex.value = index
  })
  function dispose() { closeViewer(); onViewerClosed() }
  onDeactivated(dispose)
  onUnmounted(() => { disposed = true; dispose() })

  return { viewerIndex, viewerUrl, current, openViewer, closeViewer, onViewerClosed, step }
}

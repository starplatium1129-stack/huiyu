import { sameArtworkMedia } from './artworkMediaIdentity'
import { computed, onDeactivated, onUnmounted, ref, watch, type Ref } from 'vue'
import { artworkRepository } from '@/storage/artworkRepository'
import type { ArtworkRecord } from '@/types/artwork'
import { artworkIndexById, safeImageUrl } from './galleryHelpers'

/** Gallery owns the image until its enclosing transition actually finishes. */
export function useGalleryViewer(options: {
  history: Ref<ArtworkRecord[]>
  visible: Ref<ArtworkRecord[]>
  previewSource?: (item: ArtworkRecord) => string
  resetControls: () => void
}) {
  const viewerIndex = ref(-1)
  const viewerItemId = ref<string | number | null>(null)
  const viewerUrl = ref('')
  const neighborPreviews = ref<Record<string, string>>({})
  const current = computed(() => {
    const index = artworkIndexById(options.history.value, viewerItemId.value)
    return index >= 0 ? options.history.value[index] : null
  })
  let loadedMedia: ArtworkRecord | null = null
  let objectUrl = ''
  let loadToken = 0
  let disposed = false
  let loading: AbortController | null = null
  let previewRevision = 0

  function hydratePreviews() {
    const revision = ++previewRevision
    const center = artworkIndexById(options.visible.value, viewerItemId.value)
    neighborPreviews.value = {}
    if (viewerIndex.value < 0 || center < 0) return
    for (const source of options.visible.value.slice(Math.max(0, center - 2), center + 3)) {
      if (options.previewSource?.(source)) continue
      const item = { ...source }
      void (async () => {
        let url = ''
        try {
          const thumbnail = item.image_id ? await artworkRepository.getThumbnail(item.image_id) : null
          if (thumbnail?.startsWith('data:image/')) url = thumbnail
        } catch { /* Missing previews stay empty; neighboring originals are never fetched here. */ }
        const live = options.visible.value.find(candidate => String(candidate.id) === String(item.id))
        if (!disposed && viewerIndex.value >= 0 && revision === previewRevision && sameArtworkMedia(live, item) && url)
          neighborPreviews.value = { ...neighborPreviews.value, [item.id]: url }
      })()
    }
  }

  function releaseImage() {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = ''
    viewerUrl.value = ''
    loadedMedia = null
  }

  async function hydrate(source: ArtworkRecord) {
    const item = { ...source }
    loading?.abort()
    const request = new AbortController()
    loading = request
    releaseImage()
    loadedMedia = item
    const token = ++loadToken
    const fallback = safeImageUrl(item.image_url) || (item.image_data?.startsWith('data:image/') ? item.image_data : '')
    try {
      const blob = item.image_id ? await artworkRepository.getImage(item.image_id, request.signal) : null
      if (disposed || request.signal.aborted || token !== loadToken || !sameArtworkMedia(current.value ?? undefined, item)) return
      if (blob) {
        objectUrl = URL.createObjectURL(blob)
        viewerUrl.value = objectUrl
      } else viewerUrl.value = fallback
    } catch {
      if (!disposed && !request.signal.aborted && token === loadToken && sameArtworkMedia(current.value ?? undefined, item)) viewerUrl.value = fallback
    } finally { if (loading === request) loading = null }
  }

  function openViewer(index: number) {
    const item = options.visible.value[index]
    if (disposed || !item) return
    // Double clicks and gesture-viewer change events can select the same image
    // before its original finishes. Keep the owned read until close or a switch.
    const reuseImage = sameArtworkMedia(loadedMedia ?? undefined, item) && Boolean(viewerUrl.value || (loading && !loading.signal.aborted))
    viewerItemId.value = item.id
    viewerIndex.value = index
    options.resetControls()
    if (!reuseImage) void hydrate(item)
    hydratePreviews()
  }

  function closeViewer() {
    loading?.abort(); loading = null
    loadToken++
    previewRevision++
    viewerIndex.value = -1
    // Keep image, comparison and metadata intact while the surface leaves.
  }

  function onViewerClosed() {
    // A reversed leave must never clear the image of the reopened viewer.
    if (viewerIndex.value >= 0) return
    viewerItemId.value = null
    neighborPreviews.value = {}
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
    hydratePreviews()
  })
  watch(() => { const item = current.value; return item && [item.image_id, item.image_url, item.image_data] }, () => {
    if (viewerIndex.value >= 0 && current.value && !sameArtworkMedia(loadedMedia ?? undefined, current.value)) { void hydrate(current.value); hydratePreviews() }
  })
  function dispose() { closeViewer(); onViewerClosed() }
  onDeactivated(dispose)
  onUnmounted(() => { disposed = true; dispose() })

  return { viewerIndex, viewerUrl, neighborPreviews, current, openViewer, closeViewer, onViewerClosed, step, getViewerRevision: () => previewRevision }
}

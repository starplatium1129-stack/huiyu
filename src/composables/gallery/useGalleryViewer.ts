import { sameArtworkMedia } from './artworkMediaIdentity'
import { computed, onDeactivated, onUnmounted, ref, shallowRef, watch, type Ref } from 'vue'
import { artworkRepository } from '@/storage/artworkRepository'
import { useOriginalImage } from '../useOriginalImage'
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
  const original = useOriginalImage()
  const viewerUrl = original.url
  const viewerLoadFailed = computed(() => Boolean(original.error.value))
  const neighborPreviews = shallowRef<Record<string, string>>(Object.create(null))
  const details = shallowRef<ArtworkRecord | null>(null)
  const current = computed(() => {
    const index = artworkIndexById(options.history.value, viewerItemId.value)
    const item = index >= 0 ? options.history.value[index] : null
    return item?._gallerySummary && details.value?.id === item.id && details.value._galleryRevision === item._galleryRevision
      ? { ...details.value, favorite: item.favorite } : item
  })
  let loadedMedia: ArtworkRecord | null = null
  let disposed = false
  let previewRevision = 0

  function hydratePreviews() {
    const revision = ++previewRevision
    const repository = artworkRepository, session = original.session.value
    const center = artworkIndexById(options.visible.value, viewerItemId.value)
    neighborPreviews.value = Object.create(null)
    if (viewerIndex.value < 0 || center < 0) return
    for (const source of options.visible.value.slice(Math.max(0, center - 2), center + 3)) {
      if (options.previewSource?.(source)) continue
      const item = { ...source }
      void (async () => {
        let url = ''
        try {
          const thumbnail = item.image_id ? await repository.getThumbnail(item.image_id) : null
          if (thumbnail?.startsWith('data:image/')) url = thumbnail
        } catch { /* Missing previews stay empty; neighboring originals are never fetched here. */ }
        if (disposed || viewerIndex.value < 0 || revision !== previewRevision || repository !== artworkRepository
          || session !== original.session.value || !url) return
        const live = options.visible.value.find(candidate => String(candidate.id) === String(item.id))
        if (sameArtworkMedia(live, item))
          neighborPreviews.value = Object.assign(Object.create(null), neighborPreviews.value, { [item.id]: url })
      })()
    }
  }

  function releaseImage() {
    original.release()
    loadedMedia = null
    details.value = null
  }

  async function hydrate(source: ArtworkRecord, preserve = false) {
    let item = { ...source }
    loadedMedia = item
    await original.load({
      preserve,
      current: () => !disposed && viewerIndex.value >= 0 && sameArtworkMedia(current.value ?? undefined, item),
      async read(signal, repository) {
        if (item._gallerySummary) {
          const complete = await repository.readArtwork(item.id, signal)
          signal.throwIfAborted()
          if (!complete) throw new Error('这幅作品已不在作品册')
          item = { ...complete, _galleryRevision: item._galleryRevision }
          loadedMedia = { ...item }; details.value = item
        }
        const fallback = safeImageUrl(item.image_url) || (item.image_data?.startsWith('data:image/') ? item.image_data : '')
        try { return (item.image_id ? await repository.getImage(item.image_id, signal) : null) || fallback }
        catch { signal.throwIfAborted(); return fallback }
      },
    })
  }
  async function retryViewerImage() {
    if (!disposed && viewerIndex.value >= 0 && current.value) await hydrate(current.value, true)
  }

  function openViewer(index: number) {
    const item = options.visible.value[index]
    if (disposed || !item) return
    // Double clicks and gesture-viewer change events can select the same image
    // before its original finishes. Keep the owned read until close or a switch.
    const reuseImage = sameArtworkMedia(loadedMedia ?? undefined, item) && Boolean(viewerUrl.value || original.loading.value)
    viewerItemId.value = item.id
    if (details.value?.id !== item.id) details.value = null
    viewerIndex.value = index
    options.resetControls()
    if (!reuseImage) void hydrate(item)
    hydratePreviews()
  }

  function closeViewer() {
    original.stop()
    previewRevision++
    viewerIndex.value = -1
    // Keep image, comparison and metadata intact while the surface leaves.
  }

  function onViewerClosed() {
    // A reversed leave must never clear the image of the reopened viewer.
    if (viewerIndex.value >= 0) return
    viewerItemId.value = null
    neighborPreviews.value = Object.create(null)
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
  watch(() => { const item = current.value; return item && [item.image_id, item.image_url, item.image_data, item._galleryRevision] }, () => {
    const item = current.value
    const changedDetails = item?._gallerySummary && loadedMedia?._galleryRevision !== item._galleryRevision
    if (viewerIndex.value >= 0 && item && (changedDetails || !sameArtworkMedia(loadedMedia ?? undefined, item))) { void hydrate(item); hydratePreviews() }
  })
  function dispose() { closeViewer(); onViewerClosed() }
  watch(original.session, dispose)
  onDeactivated(dispose)
  onUnmounted(() => { disposed = true; dispose() })

  return { viewerIndex, viewerUrl, viewerLoadFailed, retryViewerImage, neighborPreviews, current, openViewer, closeViewer, onViewerClosed, step, getViewerRevision: () => previewRevision }
}

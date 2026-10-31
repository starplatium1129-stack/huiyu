import { nextTick, onUnmounted, reactive, readonly, ref, watch, type Ref } from 'vue'
import { useDevicePixelRatio, useResizeObserver } from '@vueuse/core'
import { artworkRepository } from '@/storage/artworkRepository'
import { artworkTimestamp, type ArtworkRecord } from '@/types/artwork'
import { onDesktopRuntime } from '@/platform/desktop/runtime'
import { imageMediaSession } from '@/platform/imageMediaSession'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { cardPreviewImage } from '@/utils/cardPreviewImage'

/** Three home cards own display-sized previews, with cancellable original fallback. */
export function useHomeRecentWorks(grid: Ref<HTMLElement | null>) {
  const recentWorks = ref<ArtworkRecord[]>([])
  const loading = ref(true)
  const error = ref('')
  const coverUrls = reactive(new Map<string, string>())
  const sourceRevision = ref(0)
  let repositoryOwner = artworkRepository, mediaSession = imageMediaSession()
  let request: AbortController | null = null
  let coverRequest: AbortController | null = null
  let requestedWidth = 0
  let disposed = false
  const { pixelRatio } = useDevicePixelRatio()
  function clearCovers() {
    coverRequest?.abort(); coverRequest = null; requestedWidth = 0
    for (const url of coverUrls.values()) if (url.startsWith('blob:')) URL.revokeObjectURL(url)
    coverUrls.clear()
  }
  function setCover(id: string, url: string) {
    const previous = coverUrls.get(id)
    if (previous?.startsWith('blob:')) URL.revokeObjectURL(previous)
    coverUrls.set(id, url)
  }
  async function loadCovers() {
    const card = grid.value?.querySelector<HTMLElement>('.recent-cover')
    if (disposed || !card?.clientWidth || !recentWorks.value.length) return
    // Match the gallery's size buckets and include the real display density.
    const width = Math.ceil(card.clientWidth * pixelRatio.value * 1.06 / 560) * 560
    if (width <= requestedWidth) return
    requestedWidth = width
    coverRequest?.abort()
    const controller = new AbortController(); coverRequest = controller
    const repository = artworkRepository, session = imageMediaSession()
    const current = () => !disposed && !controller.signal.aborted && coverRequest === controller
      && repository === artworkRepository && session === imageMediaSession()
    await Promise.all(recentWorks.value.map(async item => {
      const id = item.image_id
      if (!id || !current()) return
      try {
        if (!coverUrls.has(id)) {
          const thumbnail = await repository.getThumbnail(id).catch(() => null)
          if (!current()) return
          if (thumbnail?.startsWith('data:image/')) setCover(id, thumbnail)
        }
        // Small stored thumbnails are only a warm frame, never the final card.
        const preview = await repository.getPreview?.(id, width, controller.signal).catch(() => null)
        if (!current()) return
        if (preview) { setCover(id, preview); return }
        const blob = await repository.getImage(id, controller.signal)
        if (!blob || !current()) return
        const derived = await cardPreviewImage(blob, width, controller.signal)
        if (!current()) return
        setCover(id, URL.createObjectURL(derived?.blob || blob))
      } catch { /* Keep the available thumbnail when optional HD loading fails. */ }
    }))
    if (coverRequest === controller) coverRequest = null
  }
  useResizeObserver(grid, () => { void loadCovers() })
  watch(pixelRatio, () => { void loadCovers() })
  function refreshSource() {
    if (disposed) return
    const next = imageMediaSession()
    if (repositoryOwner === artworkRepository && next === mediaSession) return
    repositoryOwner = artworkRepository; mediaSession = next
    // A reconnect cannot revive the old read, even if its fields match again.
    request?.abort(); request = null; loading.value = false
    sourceRevision.value++
    clearCovers(); recentWorks.value = []
    error.value = '作品来源已变化，请重新读取最近创作。'
  }
  const stopRuntime = onDesktopRuntime(refreshSource)
  watch(runtimeResourceIdentity, refreshSource, { flush: 'sync' })
  async function load() {
    if (disposed) return
    refreshSource()
    request?.abort()
    coverRequest?.abort()
    loading.value = true; error.value = ''
    const repository = artworkRepository, session = imageMediaSession()
    const controller = new AbortController(); request = controller
    const current = () => !disposed && !controller.signal.aborted && request === controller
      && repository === artworkRepository && session === imageMediaSession()
    try {
      const history = await repository.readRecentHistory(controller.signal)
      if (!current()) return
      clearCovers()
      recentWorks.value = history.slice().sort((a, b) => artworkTimestamp(b) - artworkTimestamp(a)).slice(0, 3)
      await nextTick()
      if (current()) void loadCovers()
    } catch (cause) {
      if (current()) { error.value = '作品库暂时无法读取，请重试。'; console.warn('读取历史失败', cause) }
    } finally {
      refreshSource()
      if (request === controller) { loading.value = false; request = null }
    }
  }
  onUnmounted(() => { disposed = true; stopRuntime(); request?.abort(); request = null; clearCovers() })
  return { recentWorks, loading, error, sourceRevision: readonly(sourceRevision),
    coverUrl: (item: ArtworkRecord) => item.image_id ? coverUrls.get(item.image_id) || '' : '', load }
}

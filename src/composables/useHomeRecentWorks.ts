import { nextTick, onUnmounted, reactive, readonly, ref, watch, type Ref } from 'vue'
import { useDevicePixelRatio, useIntersectionObserver, useResizeObserver } from '@vueuse/core'
import { artworkRepository } from '@/storage/artworkRepository'
import { artworkTimestamp, type ArtworkRecord } from '@/types/artwork'
import { onDesktopRuntime } from '@/platform/desktop/runtime'
import { imageMediaSession } from '@/platform/imageMediaSession'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { cardPreviewImage } from '@/utils/cardPreviewImage'

// Seed returning cards only after the repository has confirmed their current IDs.
// The three bounded strings need no Blob URL lease while the home page is closed.
let lastCovers = { owner: artworkRepository, session: imageMediaSession(), urls: new Map<string, string>() }

/** Three home cards own display-sized previews, with cancellable original fallback. */
export function useHomeRecentWorks(grid: Ref<HTMLElement | null>) {
  const recentWorks = ref<ArtworkRecord[]>([])
  const loading = ref(true)
  const error = ref('')
  const coverUrls = reactive(new Map<string, string>())
  const paintedUrls = reactive(new Map<string, string>())
  const sourceRevision = ref(0)
  let repositoryOwner = artworkRepository, mediaSession = imageMediaSession()
  let request: AbortController | null = null
  let coverRequest: AbortController | null = null
  let requestedWidth = 0
  let disposed = false
  let nearViewport = typeof IntersectionObserver === 'undefined'
  const { pixelRatio } = useDevicePixelRatio()
  const retired = new Set<string>()
  function releaseUnusedCovers() {
    if (!retired.size) return
    const visible = new Set(Array.from(grid.value?.querySelectorAll<HTMLImageElement>('.recent-cover img') ?? [], image => image.src))
    for (const url of retired) if (!visible.has(url)) { URL.revokeObjectURL(url); retired.delete(url) }
  }
  function clearCovers() {
    coverRequest?.abort(); coverRequest = null; requestedWidth = 0
    for (const url of coverUrls.values()) if (url.startsWith('blob:')) URL.revokeObjectURL(url)
    coverUrls.clear()
    paintedUrls.clear()
    for (const url of retired) URL.revokeObjectURL(url)
    retired.clear()
  }
  function setCover(id: string, url: string) {
    const previous = coverUrls.get(id)
    if (previous === url) return
    if (previous?.startsWith('blob:')) { retired.add(previous); void nextTick(releaseUnusedCovers) }
    coverUrls.set(id, url)
  }
  async function loadCovers() {
    if (disposed || !nearViewport || !recentWorks.value.length) return
    const card = grid.value?.querySelector<HTMLElement>('.recent-cover')
    if (!card?.clientWidth) return
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
        // The desktop can read the display-sized derivative directly. Avoid
        // generating two different thumbnails of every new work on first load.
        const preview = await repository.getPreview?.(id, width, controller.signal).catch(() => null)
        if (!current()) return
        if (preview) {
          setCover(id, preview)
          if (preview.startsWith('data:image/') && preview.length <= 1024 * 1024) lastCovers.urls.set(id, preview)
          else lastCovers.urls.delete(id)
          return
        }
        if (!coverUrls.has(id)) {
          const thumbnail = await repository.getThumbnail(id).catch(() => null)
          if (!current()) return
          if (thumbnail?.startsWith('data:image/')) setCover(id, thumbnail)
        }
        // Legacy Web repositories have only a small thumbnail and an original.
        const blob = await repository.getImage(id, controller.signal)
        if (!blob || !current()) return
        const derived = await cardPreviewImage(blob, width, controller.signal)
        if (!current()) return
        setCover(id, URL.createObjectURL(derived?.blob || blob))
      } catch { /* Keep the available thumbnail when optional HD loading fails. */ }
    }))
    if (coverRequest === controller) coverRequest = null
  }
  // Native image lazy-loading cannot defer a repository read that creates the URL.
  useIntersectionObserver(grid, ([entry]) => {
    if (!entry || entry.target !== grid.value) return
    nearViewport = entry.isIntersecting
    if (nearViewport) void loadCovers()
  }, { rootMargin: '240px' })
  useResizeObserver(grid, () => { void loadCovers() })
  watch(pixelRatio, () => { void loadCovers() })
  function refreshSource() {
    if (disposed) return
    const next = imageMediaSession()
    if (repositoryOwner === artworkRepository && next === mediaSession) return
    repositoryOwner = artworkRepository; mediaSession = next
    lastCovers = { owner: repositoryOwner, session: next, urls: new Map() }
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
      const recent = history.toSorted((a, b) => artworkTimestamp(b) - artworkTimestamp(a)).slice(0, 3)
      const ids = new Set(recent.map(item => item.image_id))
      if (lastCovers.owner !== repository || lastCovers.session !== session) {
        lastCovers = { owner: repository, session, urls: new Map() }
      }
      for (const id of lastCovers.urls.keys()) if (!ids.has(id)) lastCovers.urls.delete(id)
      for (const [id, url] of coverUrls) if (!ids.has(id)) {
        if (url.startsWith('blob:')) retired.add(url)
        coverUrls.delete(id)
        paintedUrls.delete(id)
      }
      for (const [id, url] of lastCovers.urls) if (!coverUrls.has(id)) coverUrls.set(id, url)
      requestedWidth = 0
      recentWorks.value = recent
      await nextTick()
      releaseUnusedCovers()
      if (current()) void loadCovers()
    } catch (cause) {
      if (current()) { error.value = '作品库暂时无法读取，请重试。'; console.warn('读取历史失败', cause) }
    } finally {
      refreshSource()
      if (request === controller) { loading.value = false; request = null }
    }
  }
  onUnmounted(() => { disposed = true; stopRuntime(); request?.abort(); request = null; clearCovers() })
  function markPainted(item: ArtworkRecord, url: string) {
    if (item.image_id && coverUrls.get(item.image_id) === url) paintedUrls.set(item.image_id, url)
  }
  function coverUrl(item: ArtworkRecord) { return item.image_id ? coverUrls.get(item.image_id) || '' : '' }
  function previewUrl(item: ArtworkRecord) { return (item.image_id && paintedUrls.get(item.image_id)) || coverUrl(item) }
  return { recentWorks, loading, error, sourceRevision: readonly(sourceRevision), coverUrl, previewUrl, load, markPainted, releaseUnusedCovers }
}

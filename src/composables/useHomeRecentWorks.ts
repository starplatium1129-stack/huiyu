import { onUnmounted, reactive, readonly, ref, watch } from 'vue'
import { artworkRepository } from '@/storage/artworkRepository'
import { artworkTimestamp, type ArtworkRecord } from '@/types/artwork'
import { onDesktopRuntime } from '@/platform/desktop/runtime'
import { imageMediaSession } from '@/platform/imageMediaSession'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'

/** The home cards borrow derived previews; originals are a cancellable fallback. */
export function useHomeRecentWorks() {
  const recentWorks = ref<ArtworkRecord[]>([])
  const loading = ref(true)
  const error = ref('')
  const coverUrls = reactive(new Map<string, string>())
  const sourceRevision = ref(0)
  let repositoryOwner = artworkRepository, mediaSession = imageMediaSession()
  let request: AbortController | null = null
  let disposed = false
  function clearCovers() {
    for (const url of coverUrls.values()) if (url.startsWith('blob:')) URL.revokeObjectURL(url)
    coverUrls.clear()
  }
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
      await Promise.all(recentWorks.value.map(async item => {
        const id = item.image_id
        if (!id || !current()) return
        try {
          const thumbnail = await repository.getThumbnail(id).catch(() => null)
          if (!current()) return
          if (thumbnail?.startsWith('data:image/')) { coverUrls.set(id, thumbnail); return }
          const blob = await repository.getImage(id, controller.signal)
          if (!blob || !current()) return
          const previous = coverUrls.get(id)
          if (previous?.startsWith('blob:')) URL.revokeObjectURL(previous)
          coverUrls.set(id, URL.createObjectURL(blob))
        } catch { /* A missing preview does not block the recent-work links. */ }
      }))
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

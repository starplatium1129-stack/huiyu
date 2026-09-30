import { onUnmounted, reactive, ref } from 'vue'
import { artworkRepository } from '@/storage/artworkRepository'
import { artworkTimestamp, type ArtworkRecord } from '@/types/artwork'

/** The home cards borrow derived previews; originals are a cancellable fallback. */
export function useHomeRecentWorks() {
  const recentWorks = ref<ArtworkRecord[]>([])
  const coverUrls = reactive<Record<string, string>>({})
  let request: AbortController | null = null
  let disposed = false
  function clearCovers() {
    for (const [id, url] of Object.entries(coverUrls)) {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url)
      delete coverUrls[id]
    }
  }
  async function load() {
    if (disposed) return
    request?.abort(); clearCovers()
    const controller = new AbortController(); request = controller
    const current = () => !disposed && !controller.signal.aborted && request === controller
    try {
      const history = await artworkRepository.readRecentHistory(controller.signal)
      if (!current()) return
      recentWorks.value = history.slice().sort((a, b) => artworkTimestamp(b) - artworkTimestamp(a)).slice(0, 3)
      await Promise.all(recentWorks.value.map(async item => {
        const id = item.image_id
        if (!id) return
        try {
          const thumbnail = await artworkRepository.getThumbnail(id).catch(() => null)
          if (!current()) return
          if (thumbnail?.startsWith('data:image/')) { coverUrls[id] = thumbnail; return }
          const blob = await artworkRepository.getImage(id, controller.signal)
          if (!blob || !current()) return
          const previous = coverUrls[id]
          if (previous?.startsWith('blob:')) URL.revokeObjectURL(previous)
          coverUrls[id] = URL.createObjectURL(blob)
        } catch { /* A missing preview does not block the recent-work links. */ }
      }))
    } catch (error) { if (current()) console.warn('读取历史失败', error) }
    finally { if (request === controller) request = null }
  }
  onUnmounted(() => { disposed = true; request?.abort(); request = null; clearCovers() })
  return { recentWorks, coverUrl: (item: ArtworkRecord) => item.image_id ? coverUrls[item.image_id] || '' : '', load }
}

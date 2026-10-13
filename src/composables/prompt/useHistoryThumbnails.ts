import { onActivated, onDeactivated, reactive, ref, watch } from 'vue'
import { artworkRepository } from '@/storage/artworkRepository'
import type { ArtworkRecord } from '@/types/artwork'
import { blobThumbDataUrl } from '@/utils/imageThumb'

/** Only the visible history tab owns reads. Keep small previews, never original Blob URLs. */
export function useHistoryThumbnails(items: () => ArtworkRecord[], active: () => boolean) {
  const thumbs = reactive<Record<string | number, string>>({})
  const pageActive = ref(true)
  onActivated(() => { pageActive.value = true })
  onDeactivated(() => { pageActive.value = false })
  watch([active, pageActive, () => items().map(item => [item.id, item.image_id] as const)],
    ([visible, activated, entries], _previous, onCleanup) => {
      const controller = new AbortController()
      onCleanup(() => {
        controller.abort()
        for (const id of Object.keys(thumbs)) delete thumbs[id]
      })
      if (!visible || !activated) return
      const repository = artworkRepository
      let next = 0
      async function worker() {
        while (!controller.signal.aborted && next < entries.length) {
          const [id, imageId] = entries[next++]
          if (!imageId) continue
          try {
            let thumbnail = await repository.getThumbnail(imageId).catch(() => null)
            if (controller.signal.aborted) return
            if (!thumbnail) {
              // Older Web records may lack derived previews. Downsample one visible
              // original at a time per worker; the repository owns its cache policy.
              const blob = await repository.getImage(imageId, controller.signal)
              if (controller.signal.aborted) return
              if (blob) thumbnail = await blobThumbDataUrl(blob)
            }
            if (controller.signal.aborted) return
            if (thumbnail?.startsWith('data:image/')) thumbs[id] = thumbnail
          } catch (error) {
            if (!controller.signal.aborted) console.warn('history thumbnail unavailable', error)
          }
        }
      }
      void Promise.all(Array.from({ length: Math.min(2, entries.length) }, worker))
    }, { immediate: true })
  return thumbs
}

import { onActivated, onDeactivated, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { artworkRepository } from '@/storage/artworkRepository'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { imageMediaSession } from '@/platform/imageMediaSession'
import { onDesktopRuntime } from '@/platform/desktop/runtime'
import type { ArtworkRecord } from '@/types/artwork'
import { blobThumbDataUrl } from '@/utils/imageThumb'
import { createImageReadSlot } from '@/utils/imageReadSlot'

/** Only the visible history tab owns reads. Keep small previews, never original Blob URLs. */
export function useHistoryThumbnails(items: () => ArtworkRecord[], active: () => boolean) {
  const thumbs = shallowRef<Record<string | number, string>>(Object.create(null))
  let imageIds = new Map<string, string | undefined>()
  let repositoryOwner = artworkRepository
  const reads = [createImageReadSlot(), createImageReadSlot()]
  const mediaVisit = ref(0)
  let mediaSession = imageMediaSession()
  function stopReads() { for (const slot of reads) slot.stop() }
  function refreshSession() {
    const next = imageMediaSession()
    if (next === mediaSession) return
    mediaSession = next; mediaVisit.value++; stopReads()
  }
  const stopRuntime = onDesktopRuntime(refreshSession)
  watch(runtimeResourceIdentity, refreshSession, { flush: 'sync' })
  function clear() {
    imageIds.clear()
    thumbs.value = Object.create(null)
  }
  onScopeDispose(() => { stopRuntime(); stopReads(); clear() })
  const pageActive = ref(true)
  onActivated(() => { pageActive.value = true })
  onDeactivated(() => { pageActive.value = false })
  // History metadata can refresh without changing any displayed image.
  watch([active, pageActive, mediaVisit, () => JSON.stringify(items().map(item => [item.id, item.image_id]))],
    ([visible, activated, identity], previous, onCleanup) => {
      const controller = new AbortController()
      onCleanup(() => { controller.abort(); stopReads() })
      const repository = artworkRepository
      const session = imageMediaSession()
      if (!visible || !activated || repository !== repositoryOwner || identity !== previous?.[2]) clear()
      repositoryOwner = repository
      if (!visible || !activated) return
      const entries = items().map(item => [item.id, item.image_id] as const)
      // Reuse completed previews only while their record and image remain in this window.
      const nextImages = new Map(entries.map(([id, imageId]) => [String(id), imageId] as const))
      let retained: Record<string | number, string> | undefined
      for (const id of Object.keys(thumbs.value)) {
        if (!nextImages.has(id) || nextImages.get(id) !== imageIds.get(id)) {
          retained ??= Object.assign(Object.create(null), thumbs.value) as Record<string | number, string>
          delete retained[id]
        }
      }
      if (retained) thumbs.value = retained
      imageIds = nextImages
      const current = () => !controller.signal.aborted && repository === artworkRepository
        && identity === mediaVisit.value && session === imageMediaSession()
      let next = 0
      async function worker(slot: ReturnType<typeof createImageReadSlot>) {
        while (current() && next < entries.length) {
          const [id, imageId] = entries[next++]
          if (!imageId || thumbs.value[id]) continue
          try {
            const thumbnail = await slot.read(async () => {
              let value = await repository.getThumbnail(imageId).catch(() => null)
              if (!current()) return null
              if (!value) {
                // Keep the slot through the actual read and encode. Cancelling only
                // this page's wait must not admit another original into the same slot.
                const blob = await repository.getImage(imageId)
                if (!current()) return null
                if (blob) value = await blobThumbDataUrl(blob)
              }
              return value
            }, { signal: controller.signal, current })
            if (!current()) return
            if (thumbnail?.startsWith('data:image/')) thumbs.value = Object.assign(Object.create(null), thumbs.value, { [id]: thumbnail })
          } catch (error) {
            if (current()) console.warn('history thumbnail unavailable', error)
          }
        }
      }
      void Promise.all(reads.slice(0, entries.length).map(worker))
    }, { immediate: true })
  return thumbs
}

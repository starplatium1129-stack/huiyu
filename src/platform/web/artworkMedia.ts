import { imgPut, imgGet, imgCount } from '../../composables/useImageStore.ts'
import { blobThumbDataUrl, thumbKey } from '../../utils/imageThumb.ts'
import type { ArtworkKvAdapter, ArtworkImageAdapter } from './artworkStorage.ts'

export function createArtworkMedia(kv: ArtworkKvAdapter, images: ArtworkImageAdapter) {
  async function getThumbnail(id: string): Promise<string | null> {
    const value = await kv.get(thumbKey(id))
    return typeof value === 'string' ? value : null
  }

  const setThumbnail = (id: string, dataUrl: string) => kv.set(thumbKey(id), dataUrl)

  async function cacheThumbnail(id: string, blob: Blob): Promise<void> {
    try {
      const dataUrl = await blobThumbDataUrl(blob)
      if (dataUrl) await setThumbnail(id, dataUrl)
    } catch { /* Thumbnails remain best-effort derived data. */ }
  }

  return {
    getImage: async (id: string, signal?: AbortSignal) => {
      // IndexedDB adapter reads are not abortable; suppress obsolete publication.
      signal?.throwIfAborted()
      const blob = await imgGet(id)
      signal?.throwIfAborted()
      return blob
    },
    putImage: imgPut,
    deleteImage: (id: string) => images.deleteMany([id]),
    countImages: imgCount,
    getThumbnail, setThumbnail, cacheThumbnail,
  }
}

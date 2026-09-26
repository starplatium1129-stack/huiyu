import { imgPut, imgGet, imgCount } from '../../composables/useImageStore.ts'
import { blobThumbDataUrl, thumbKey } from '../../utils/imageThumb.ts'
import type { ArtworkKvAdapter, ArtworkImageAdapter, WebArtworkRepositoryDependencies } from './artworkStorage.ts'

export function createArtworkMedia(kv: ArtworkKvAdapter, images: ArtworkImageAdapter, dependencies: WebArtworkRepositoryDependencies) {
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
    getImage: (id: string) => dependencies.images ? images.get(id).then(record => record?.blob ?? null) : imgGet(id),
    putImage: (blob: Blob) => dependencies.images?.put ? dependencies.images.put(blob) : imgPut(blob),
    deleteImage: (id: string) => images.deleteMany([id]),
    countImages: () => dependencies.images?.count ? dependencies.images.count() : imgCount(),
    getThumbnail, setThumbnail, cacheThumbnail,
  }
}

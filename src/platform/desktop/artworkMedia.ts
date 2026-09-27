import { blobThumbDataUrl } from '../../utils/imageThumb.ts'
import { desktopRuntimeFetch, getDesktopRuntime } from './runtime.ts'

// Count keys and strings conservatively as UTF-16, retaining only recent pages.
const THUMBNAIL_CACHE_LIMIT = 96
const THUMBNAIL_CACHE_BYTES = 8 * 1024 * 1024

/** Desktop thumbnails are derived in the workspace, so cold gallery visits never
 * download originals just to create previews. Original reads only share in-flight
 * work: resolved large blobs remain owned and released by their callers. */
export function createDesktopArtworkMedia(requireAuthority: () => void, readThumbnail: (id: string) => Promise<string | null>) {
  const images = new Map<string, Promise<Blob | null>>()
  const pendingThumbnails = new Map<string, Promise<string | null>>()
  const thumbnails = new Map<string, string>()
  let thumbnailBytes = 0
  function key(id: string) {
    requireAuthority()
    const runtime = getDesktopRuntime().bootstrap?.runtime
    return JSON.stringify([runtime?.runtimeEpoch, runtime?.workspace?.generation, id])
  }
  function forget(identity: string) {
    const previous = thumbnails.get(identity)
    if (previous !== undefined) { thumbnailBytes -= (identity.length + previous.length) * 2; thumbnails.delete(identity) }
  }
  function remember(identity: string, value: string) {
    forget(identity)
    const bytes = (identity.length + value.length) * 2
    if (!value || bytes > THUMBNAIL_CACHE_BYTES) return
    thumbnails.set(identity, value); thumbnailBytes += bytes
    while (thumbnails.size > THUMBNAIL_CACHE_LIMIT || thumbnailBytes > THUMBNAIL_CACHE_BYTES) {
      forget(thumbnails.keys().next().value!)
    }
  }
  function forgetThumbnail(id: string) {
    const identity = key(id)
    forget(identity)
    pendingThumbnails.delete(identity)
  }
  async function fetchImage(id: string): Promise<Blob | null> {
    const signal = AbortSignal.timeout(35_000)
    const response = await desktopRuntimeFetch('/api/workspace/media-capabilities', { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias: id }) })
    if (response.status === 404) return null
    if (!response.ok) throw new Error('作品原图暂时不可用')
    const capability = await response.json() as { url: string }
    const media = await desktopRuntimeFetch(capability.url, { signal })
    if (!media.ok) throw new Error('作品原图读取未完成')
    return media.blob()
  }
  async function getImage(id: string): Promise<Blob | null> {
    const identity = key(id)
    let pending = images.get(identity)
    if (!pending) {
      pending = fetchImage(id)
      images.set(identity, pending)
    }
    try {
      const value = await pending
      if (key(id) !== identity) throw new Error('作品库连接已变化，请重新读取')
      return value
    }
    finally { if (images.get(identity) === pending) images.delete(identity) }
  }
  async function getThumbnail(id: string): Promise<string | null> {
    const identity = key(id)
    const cached = thumbnails.get(identity)
    if (cached) { remember(identity, cached); return cached }
    let pending = pendingThumbnails.get(identity)
    if (!pending) {
      pending = readThumbnail(id)
      pendingThumbnails.set(identity, pending)
    }
    try {
      const value = await pending
      if (key(id) !== identity) throw new Error('作品库连接已变化，请重新读取')
      // Explicit publication wins over an earlier read; a released read cannot
      // repopulate memory after deleteImage has removed it from the pending map.
      const latest = thumbnails.get(identity)
      if (latest !== undefined) return latest
      if (value && pendingThumbnails.get(identity) === pending) remember(identity, value)
      return value
    } finally { if (pendingThumbnails.get(identity) === pending) pendingThumbnails.delete(identity) }
  }
  async function setThumbnail(id: string, value: string) { remember(key(id), value) }
  async function cacheThumbnail(id: string, blob: Blob) {
    const identity = key(id)
    const value = await blobThumbDataUrl(blob)
    if (value && key(id) === identity) remember(identity, value)
  }
  return { getImage, getThumbnail, setThumbnail, cacheThumbnail, forgetThumbnail }
}

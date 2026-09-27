import { blobThumbDataUrl } from '../../utils/imageThumb.ts'
import { desktopRuntimeFetch, getDesktopRuntime } from './runtime.ts'

/** Desktop thumbnails are derived in the workspace, so cold gallery visits never
 * download originals just to create previews. Original reads only share in-flight
 * work: resolved large blobs remain owned and released by their callers. */
export function createDesktopArtworkMedia(requireAuthority: () => void, readThumbnail: (id: string) => Promise<string | null>) {
  const images = new Map<string, Promise<Blob | null>>()
  const pendingThumbnails = new Map<string, Promise<string | null>>()
  const thumbnails = new Map<string, string>()
  function key(id: string) {
    requireAuthority()
    const runtime = getDesktopRuntime().bootstrap?.runtime
    return JSON.stringify([runtime?.runtimeEpoch, runtime?.workspace?.generation, id])
  }
  function remember(identity: string, value: string) {
    thumbnails.delete(identity)
    thumbnails.set(identity, value)
    if (thumbnails.size > 200) thumbnails.delete(thumbnails.keys().next().value!)
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
      if (value) remember(identity, value)
      return value
    } finally { if (pendingThumbnails.get(identity) === pending) pendingThumbnails.delete(identity) }
  }
  async function setThumbnail(id: string, value: string) { remember(key(id), value) }
  async function cacheThumbnail(id: string, blob: Blob) {
    const identity = key(id)
    const value = await blobThumbDataUrl(blob)
    if (value && key(id) === identity) remember(identity, value)
  }
  return { getImage, getThumbnail, setThumbnail, cacheThumbnail }
}

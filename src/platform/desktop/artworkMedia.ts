import { blobThumbDataUrl } from '../../utils/imageThumb.ts'
import { desktopRuntimeFetch, getDesktopRuntime } from './runtime.ts'

// Count keys and strings conservatively as UTF-16, retaining only recent pages.
const THUMBNAIL_CACHE_LIMIT = 96
const THUMBNAIL_CACHE_BYTES = 8 * 1024 * 1024

/** Desktop thumbnails are derived in the workspace, so cold gallery visits never
 * download originals just to create previews. Original reads only share in-flight
 * work: resolved large blobs remain owned and released by their callers. */
export function createDesktopArtworkMedia(requireAuthority: () => void, readThumbnail: (id: string) => Promise<string | null>) {
  const images = new Map<string, { controller: AbortController; promise: Promise<Blob | null>; readers: number }>()
  const pendingThumbnails = new Map<string, Promise<string | null>>()
  const renderingThumbnails = new Map<string, object>()
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
    renderingThumbnails.delete(identity)
  }
  async function fetchImage(id: string, signal: AbortSignal): Promise<Blob | null> {
    const response = await desktopRuntimeFetch('/api/workspace/media-capabilities', { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias: id }) })
    if (response.status === 404) return null
    if (!response.ok) throw new Error('作品原图暂时不可用')
    const capability = await response.json() as { url: string }
    signal.throwIfAborted()
    const media = await desktopRuntimeFetch(capability.url, { signal })
    if (!media.ok) throw new Error('作品原图读取未完成')
    return media.blob()
  }
  async function getImage(id: string, signal?: AbortSignal): Promise<Blob | null> {
    signal?.throwIfAborted()
    const identity = key(id)
    let pending = images.get(identity)
    if (!pending) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new DOMException('作品原图读取超时', 'TimeoutError')), 35_000)
      const entry = { controller, readers: 0, promise: Promise.resolve<Blob | null>(null) }
      const cleanup = () => {
        clearTimeout(timer)
        if (images.get(identity) === entry) images.delete(identity)
      }
      controller.signal.addEventListener('abort', cleanup, { once: true })
      entry.promise = fetchImage(id, controller.signal).finally(() => {
        cleanup()
        controller.signal.removeEventListener('abort', cleanup)
      })
      pending = entry
      images.set(identity, pending)
    }
    const entry = pending
    entry.readers++
    return new Promise<Blob | null>((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown, value?: Blob | null) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', cancel)
        entry.controller.signal.removeEventListener('abort', abort)
        if (--entry.readers === 0 && images.get(identity) === entry) entry.controller.abort()
        if (error !== undefined) reject(error)
        else resolve(value ?? null)
      }
      const cancel = () => finish(signal?.reason)
      const abort = () => finish(entry.controller.signal.reason)
      signal?.addEventListener('abort', cancel, { once: true })
      entry.controller.signal.addEventListener('abort', abort, { once: true })
      entry.promise.then(value => {
        if (settled) return
        try {
          if (key(id) !== identity) throw new Error('作品库连接已变化，请重新读取')
          finish(undefined, value)
        } catch (error) { finish(error) }
      }, error => finish(error))
    })
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
  async function setThumbnail(id: string, value: string) {
    const identity = key(id)
    renderingThumbnails.delete(identity)
    remember(identity, value)
  }
  async function cacheThumbnail(id: string, blob: Blob) {
    const identity = key(id)
    const rendering = {}
    renderingThumbnails.set(identity, rendering)
    try {
      const value = await blobThumbDataUrl(blob)
      // Deletion, explicit publication or a newer render supersedes this work.
      if (value && renderingThumbnails.get(identity) === rendering && key(id) === identity) remember(identity, value)
    } finally { if (renderingThumbnails.get(identity) === rendering) renderingThumbnails.delete(identity) }
  }
  return { getImage, getThumbnail, setThumbnail, cacheThumbnail, forgetThumbnail }
}

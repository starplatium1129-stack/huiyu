import { blobThumbDataUrl } from '../../utils/imageThumb.ts'
import type { ArtworkDerivativeLease } from '../../application/artwork/artworkRepository.ts'
import { desktopRuntimeFetch, desktopRuntimeIdentity } from './runtime.ts'
import { rememberWorkspaceMedia, workspaceMediaAuthority } from './workspaceMediaSource.ts'

// Count keys and strings conservatively as UTF-16, retaining only recent pages.
const THUMBNAIL_CACHE_LIMIT = 96
const THUMBNAIL_CACHE_BYTES = 8 * 1024 * 1024

interface SharedRead<T> {
  controller: AbortController
  promise: Promise<T>
  readers: number
}

interface Derivative {
  blob: Blob
  url: string
  readers: number
}

function readShared<T>(reads: Map<string, SharedRead<T>>, key: string,
  read: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  let entry = reads.get(key)
  if (!entry) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new DOMException('作品读取超时', 'TimeoutError')), 35_000)
    const cleanup = () => {
      clearTimeout(timer)
      if (reads.get(key)?.controller === controller) reads.delete(key)
    }
    controller.signal.addEventListener('abort', cleanup, { once: true })
    entry = { controller, readers: 0, promise: read(controller.signal).finally(() => {
      cleanup()
      controller.signal.removeEventListener('abort', cleanup)
    }) }
    reads.set(key, entry)
  }
  const pending = entry
  pending.readers++
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const release = () => {
      if (settled) return false
      settled = true
      signal?.removeEventListener('abort', abort)
      pending.controller.signal.removeEventListener('abort', cancelled)
      if (--pending.readers === 0 && reads.get(key) === pending) pending.controller.abort()
      return true
    }
    const abort = () => { if (release()) reject(signal?.reason) }
    const cancelled = () => { if (release()) reject(pending.controller.signal.reason) }
    signal?.addEventListener('abort', abort, { once: true })
    pending.controller.signal.addEventListener('abort', cancelled, { once: true })
    pending.promise.then(value => { if (release()) resolve(value) }, error => { if (release()) reject(error) })
  })
}

/** Desktop thumbnails are derived in the workspace, so cold gallery visits never
 * download originals just to create previews. Original reads only share in-flight
 * work: resolved large blobs remain owned and released by their callers. */
export function createDesktopArtworkMedia(requireAuthority: () => void, readThumbnail: (id: string) => Promise<string | null>) {
  const images = new Map<string, SharedRead<Blob | null>>()
  const derivativeReads = new Map<string, SharedRead<Derivative | null>>()
  const derivatives = new Map<string, Derivative>()
  const pendingThumbnails = new Map<string, Promise<string | null>>()
  const renderingThumbnails = new Map<string, object>()
  const thumbnails = new Map<string, string>()
  let thumbnailBytes = 0
  let mediaAuthority = desktopRuntimeIdentity()
  function key(id: string) {
    requireAuthority()
    const authority = desktopRuntimeIdentity()
    if (authority !== mediaAuthority) {
      mediaAuthority = authority
      clearImageDerivatives()
      thumbnails.clear()
      thumbnailBytes = 0
      pendingThumbnails.clear()
      renderingThumbnails.clear()
      for (const pending of images.values()) pending.controller.abort()
    }
    return JSON.stringify([authority, id])
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
    const prefix = identity + '/'
    for (const key of derivatives.keys()) if (key.startsWith(prefix)) derivatives.delete(key)
    for (const [key, pending] of derivativeReads) if (key.startsWith(prefix)) pending.controller.abort()
  }
  function clearImageDerivatives() {
    derivatives.clear()
    for (const pending of derivativeReads.values()) pending.controller.abort()
  }
  function trimDerivatives() {
    let bytes = 0
    for (const entry of derivatives.values()) bytes += entry.blob.size
    for (const [identity, entry] of derivatives) {
      if (derivatives.size <= THUMBNAIL_CACHE_LIMIT && bytes <= THUMBNAIL_CACHE_BYTES) break
      if (entry.readers > 0) continue
      derivatives.delete(identity)
      bytes -= entry.blob.size
    }
  }

  async function getImageDerivative(id: string, width?: number, signal?: AbortSignal): Promise<ArtworkDerivativeLease | null> {
    signal?.throwIfAborted()
    if (width !== undefined && (!Number.isSafeInteger(width) || width < 1 || width > 8192)) throw new Error('作品预览宽度无效')
    const authority = key(id)
    const variant = width === undefined ? 0 : [560, 1120, 1680, 2240, 3360, 4480, 8192].find(bucket => bucket >= width) ?? 8192
    const identity = authority + '/' + variant
    const entry = derivatives.get(identity) ?? await readShared(derivativeReads, identity, async readSignal => {
      const path = '/api/workspace/media/' + encodeURIComponent(id) + '/derivative'
      const response = await desktopRuntimeFetch(variant ? path + '?width=' + variant : path, { signal: readSignal, cache: 'no-cache' })
      try {
        if (response.status === 404) return null
        if (!response.ok) throw new Error('作品预览读取未完成')
        const mime = response.headers.get('content-type')
        if (mime !== 'image/jpeg' && mime !== 'image/webp') throw new Error('作品预览格式无效')
        const blob = await response.blob()
        readSignal.throwIfAborted()
        if (blob.type !== mime || !blob.size) throw new Error('作品预览内容不完整')
        const value = { blob, url: '', readers: 0 }
        derivatives.set(identity, value)
        return value
      } finally {
        if (!response.bodyUsed) await response.body?.cancel().catch(() => {})
      }
    }, signal)
    signal?.throwIfAborted()
    if (key(id) !== authority) throw new Error('作品库连接已变化，请重新读取')
    if (!entry || derivatives.get(identity) !== entry) return null
    const current = entry
    derivatives.delete(identity)
    derivatives.set(identity, current)
    current.url ||= URL.createObjectURL(current.blob)
    current.readers++
    trimDerivatives()
    let released = false
    return {
      url: current.url,
      bytes: current.blob.size,
      release() {
        if (released) return
        released = true
        if (--current.readers > 0) return
        URL.revokeObjectURL(current.url)
        current.url = ''
        trimDerivatives()
      },
    }
  }
  async function fetchImage(id: string, signal: AbortSignal): Promise<Blob | null> {
    signal.throwIfAborted()
    const authority = workspaceMediaAuthority()
    const response = await desktopRuntimeFetch(`/api/workspace/media/${encodeURIComponent(id)}/content`, { signal })
    try {
      if (response.status === 404) return null
      if (!response.ok) throw new Error('作品原图读取未完成')
      const totalHeader = response.headers.get('X-Workspace-Media-Total-Bytes')
      const total = Number(totalHeader)
      const mime = response.headers.get('X-Workspace-Media-Mime')
      const hash = response.headers.get('X-Workspace-Media-Sha256')
      if (!totalHeader || !Number.isSafeInteger(total) || total < 0 || !mime || !hash
        || response.headers.get('X-Workspace-Media-Offset') !== '0') throw new Error('作品原图信息不完整')
      const blob = await response.blob()
      signal.throwIfAborted()
      if (blob.size !== total) throw new Error('作品原图读取未完成')
      const original = new Blob([blob], { type: mime })
      rememberWorkspaceMedia(original, { alias: id, sha256: hash, bytes: total, mime }, authority)
      return original
    } finally {
      // An early rejection must release the full stream before its timer and
      // shared-reader entry retire, even when no caller reads the response body.
      if (!response.bodyUsed) await response.body?.cancel().catch(() => {})
    }
  }

  async function getImage(id: string, signal?: AbortSignal): Promise<Blob | null> {
    signal?.throwIfAborted()
    const identity = key(id)
    const value = await readShared(images, identity, readSignal => fetchImage(id, readSignal), signal)
    signal?.throwIfAborted()
    if (key(id) !== identity) throw new Error('作品库连接已变化，请重新读取')
    return value
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
  return { getImage, getImageDerivative, clearImageDerivatives, getThumbnail, setThumbnail, cacheThumbnail, forgetThumbnail }
}

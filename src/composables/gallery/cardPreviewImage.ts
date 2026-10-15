import { imageSizeWithinDecodeBudget } from '@/utils/imageDecodeBudget'

interface CardPreviewImage {
  blob: Blob
  width: number
  height: number
}

let decoding = 0
const waiting = new Set<() => void>()
function acquire(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (decoding < 2) { decoding++; return Promise.resolve() }
  return new Promise((resolve, reject) => {
    const cleanup = () => { waiting.delete(ready); signal.removeEventListener('abort', abort) }
    const ready = () => { if (decoding < 2) { cleanup(); decoding++; resolve() } }
    const abort = () => { cleanup(); reject(signal.reason) }
    waiting.add(ready); signal.addEventListener('abort', abort, { once: true })
  })
}

async function encode(source: CanvasImageSource, width: number, height: number, target: number, signal: AbortSignal): Promise<CardPreviewImage | null> {
  signal.throwIfAborted()
  const scale = Math.min(1, target / width), canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale))
  try {
    const context = canvas.getContext('2d')
    if (!context) return null
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high'
    context.drawImage(source, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', .95))
    signal.throwIfAborted()
    return blob ? { blob, width: canvas.width, height: canvas.height } : null
  }
  finally { canvas.width = canvas.height = 0 }
}

/** Alpha and full display resolution stay intact; only wall-sized pixels are retained. */
export async function cardPreviewImage(blob: Blob, width: number, signal: AbortSignal): Promise<CardPreviewImage | null> {
  await acquire(signal)
  try {
    const size = await imageSizeWithinDecodeBudget(blob)
    signal.throwIfAborted()
    if (!size) return null
    try {
      let bitmap: ImageBitmap | undefined
      // Either header edge can become the displayed width after EXIF rotation.
      // Resize only when both exceed the target, so small originals never upscale.
      if (Math.min(size.width, size.height) > width) {
        try { bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeQuality: 'high', imageOrientation: 'from-image' }) }
        catch { signal.throwIfAborted() }
        // A codec that resizes before rotating must not leave the card undersized.
        if (bitmap && bitmap.width < width) { bitmap.close(); bitmap = undefined }
      }
      bitmap ??= await createImageBitmap(blob)
      let encoding: Promise<CardPreviewImage | null>
      // encode draws before its first await; no source pixels are needed during serialization.
      try { encoding = encode(bitmap, bitmap.width, bitmap.height, width, signal) }
      finally { bitmap.close() }
      return await encoding
    } catch { signal.throwIfAborted() }
    const url = URL.createObjectURL(blob), image = new Image()
    const abort = () => image.removeAttribute('src')
    try {
      signal.addEventListener('abort', abort, { once: true }); image.decoding = 'async'; image.src = url
      await image.decode()
      return await encode(image, image.naturalWidth, image.naturalHeight, width, signal)
    } catch { signal.throwIfAborted(); return null }
    finally {
      signal.removeEventListener('abort', abort); image.removeAttribute('src'); URL.revokeObjectURL(url)
    }
  } finally {
    // Native encoding cannot be interrupted. Keep the slot until its callback
    // settles even after cancellation; the caller discards any late result.
    decoding--; for (const ready of waiting) ready()
  }
}

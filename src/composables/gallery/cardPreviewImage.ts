import { withinImageDecodeBudget } from '@/utils/imageDecodeBudget'

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

function encode(source: CanvasImageSource, width: number, height: number, target: number) {
  const scale = Math.min(1, target / width), canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (!context) return ''
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high'
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  try { return canvas.toDataURL('image/webp', .95) }
  finally { canvas.width = canvas.height = 0 }
}

/** Alpha and full display resolution stay intact; only wall-sized pixels are retained. */
export async function cardPreviewImage(blob: Blob, width: number, signal: AbortSignal): Promise<string> {
  await acquire(signal)
  try {
    if (!await withinImageDecodeBudget(blob)) return ''
    signal.throwIfAborted()
    try {
      const bitmap = await createImageBitmap(blob)
      try { signal.throwIfAborted(); return encode(bitmap, bitmap.width, bitmap.height, width) }
      finally { bitmap.close() }
    } catch { signal.throwIfAborted() }
    return await new Promise<string>((resolve, reject) => {
      const url = URL.createObjectURL(blob), image = new Image()
      const cleanup = () => { signal.removeEventListener('abort', abort); image.onload = image.onerror = null; URL.revokeObjectURL(url) }
      const abort = () => { cleanup(); image.src = ''; reject(signal.reason) }
      image.onload = () => {
        try { signal.throwIfAborted(); resolve(encode(image, image.naturalWidth, image.naturalHeight, width)) }
        catch (error) { reject(error) }
        finally { cleanup() }
      }
      image.onerror = () => { cleanup(); resolve('') }
      signal.addEventListener('abort', abort, { once: true }); image.src = url
    })
  } finally { decoding--; for (const ready of waiting) ready() }
}

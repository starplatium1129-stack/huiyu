/** 作品册缩略图：从已解码图片或 Blob 降采样成 JPEG dataURL（KV 缓存用）。 */
import { withinImageDecodeBudget } from './imageDecodeBudget.ts'
let decoding = 0
let backfilling = 0

async function canvasThumb(
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  maxWidth: number,
  quality: number,
): Promise<string> {
  if (sourceW > 8192 || sourceH > 8192 || sourceW * sourceH > 32 * 1024 * 1024) return ''
  const scale = Math.min(1, maxWidth / sourceW)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sourceW * scale))
  canvas.height = Math.max(1, Math.round(sourceH * scale))
  let blob: Blob | null
  try {
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return ''
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
    blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
  } finally {
    // Native encoding owns the pixels until its callback completes.
    canvas.width = canvas.height = 0
  }
  if (!blob) return ''
  return await new Promise<string>(resolve => {
    const reader = new FileReader()
    const finish = (value: string) => {
      reader.onload = reader.onerror = reader.onabort = null
      resolve(value)
    }
    reader.onload = () => finish(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = reader.onabort = () => finish('')
    try { reader.readAsDataURL(blob) } catch { finish('') }
  })
}

export const thumbKey = (imageId: string) => `thumb:${imageId}`

/** 从已解码的 <img> 异步出缩略图；回填繁忙时跳过，避免 load 突发堆积画布。 */
export async function jpegThumbDataUrl(img: HTMLImageElement, maxWidth = 560, quality = 0.82): Promise<string> {
  if (!img.naturalWidth || !img.naturalHeight || backfilling >= 2) return ''
  backfilling++
  try { return await canvasThumb(img, img.naturalWidth, img.naturalHeight, maxWidth, quality) }
  finally { backfilling-- }
}

/** 从 Blob 解码并出缩略图；失败返回 ''（调用方忽略即可）。 */
export async function blobThumbDataUrl(blob: Blob, maxWidth = 560, quality = 0.82): Promise<string> {
  if (decoding >= 2) return ''
  decoding++
  try {
    if (!await withinImageDecodeBudget(blob)) return ''
    return await decodeThumb(blob, maxWidth, quality)
  } catch { return '' }
  finally { decoding-- }
}

async function decodeThumb(blob: Blob, maxWidth: number, quality: number): Promise<string> {
  try {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob)
      let encoding: Promise<string>
      // Drawing happens before the first await; serialization no longer needs the source.
      try { encoding = canvasThumb(bitmap, bitmap.width, bitmap.height, maxWidth, quality) }
      finally { bitmap.close() }
      const out = await encoding
      if (out) return out
    }
  } catch { /* 落到 <img> 兜底 */ }
  return await new Promise(resolve => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    const cleanup = () => {
      img.onload = img.onerror = null
      img.removeAttribute('src')
      URL.revokeObjectURL(url)
    }
    img.onload = async () => {
      let encoding: Promise<string>
      try { encoding = canvasThumb(img, img.naturalWidth, img.naturalHeight, maxWidth, quality) }
      finally { cleanup() }
      try { resolve(await encoding) }
      catch { resolve('') }
    }
    img.onerror = () => { resolve(''); cleanup() }
    img.src = url
  })
}

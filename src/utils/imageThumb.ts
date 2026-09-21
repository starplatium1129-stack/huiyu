/** 作品册缩略图：从已解码图片或 Blob 降采样成 JPEG dataURL（KV 缓存用）。 */
import { withinImageDecodeBudget } from './imageDecodeBudget.ts'
let decoding = 0

function canvasThumb(
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  maxWidth: number,
  quality: number,
): string {
  if (sourceW > 8192 || sourceH > 8192 || sourceW * sourceH > 32 * 1024 * 1024) return ''
  const scale = Math.min(1, maxWidth / sourceW)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sourceW * scale))
  canvas.height = Math.max(1, Math.round(sourceH * scale))
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return ''
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', quality)
}

export const thumbKey = (imageId: string) => `thumb:${imageId}`

/** 从已解码的 <img> 直接出缩略图（零额外解码）。 */
export function jpegThumbDataUrl(img: HTMLImageElement, maxWidth = 560, quality = 0.82): string {
  if (!img.naturalWidth || !img.naturalHeight) return ''
  return canvasThumb(img, img.naturalWidth, img.naturalHeight, maxWidth, quality)
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
      try {
        const out = canvasThumb(bitmap, bitmap.width, bitmap.height, maxWidth, quality)
        if (out) return out
      } finally {
        bitmap.close()
      }
    }
  } catch { /* 落到 <img> 兜底 */ }
  return await new Promise(resolve => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      try { resolve(jpegThumbDataUrl(img, maxWidth, quality)) }
      catch { resolve('') }
      finally { URL.revokeObjectURL(url) }
    }
    img.onerror = () => { resolve(''); URL.revokeObjectURL(url) }
    img.src = url
  })
}

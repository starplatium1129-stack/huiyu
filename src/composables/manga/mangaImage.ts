import { mangaManifest } from '@/api/mangaApi'
import { runtimeFetch } from '@/platform/runtimeUrl'
import { artworkRepository } from '@/storage/artworkRepository'
import type { ArtworkRecord } from '@/types/artwork'
import type { MangaLinePolarity } from '@/api/mangaApi'

export interface MangaImage { blob: Blob; width: number; height: number; name: string }
export async function readMangaSource(url: string, artwork: ArtworkRecord | undefined, signal: AbortSignal): Promise<Blob> {
  if (artwork?.image_id) {
    const blob = await artworkRepository.getImage(artwork.image_id, signal)
    if (blob) return blob
  }
  if (!url) throw new Error('原图无法读取，请重新导入图片')
  const response = await runtimeFetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) })
  if (!response.ok) throw new Error(`原图读取失败（${response.status}），请重试或导入本地原图`)
  return response.blob()
}

/** Local import preview only. Raw bytes and polarity are sent separately to the native worker. */
export async function previewMangaLines(image: MangaImage, polarity: MangaLinePolarity): Promise<Blob> {
  const bitmap = await createImageBitmap(image.blob)
  try {
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法预览导入线稿，请重新打开窗口')
    ctx.fillStyle = polarity === 'black-on-white' ? '#fff' : '#000'
    ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(bitmap, 0, 0)
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
    for (let i = 0; i < pixels.data.length; i += 4) {
      const gray = (pixels.data[i]! + pixels.data[i + 1]! + pixels.data[i + 2]!) / 3
      const value = polarity === 'black-on-white' ? gray : 255 - gray
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = Math.round(value)
    }
    ctx.putImageData(pixels, 0, 0)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('线稿预览编码失败')), 'image/png'))
  } finally { bitmap.close() }
}
export async function inspectMangaImage(blob: Blob, name: string): Promise<MangaImage> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type.split(';')[0] || '')) throw new Error('请选择 PNG、JPEG 或 WebP 单张图片')
  if (blob.size > 16 * 1024 * 1024) throw new Error('图片文件超过 16 MB，请先导出较小的原图')
  const bitmap = await createImageBitmap(blob)
  try {
    if (Math.min(bitmap.width, bitmap.height) < mangaManifest.minInputSide) throw new Error('图片宽高均需至少 128 像素')
    return { blob, name, width: bitmap.width, height: bitmap.height }
  } finally { bitmap.close() }
}
export function mangaInputSize(image: MangaImage) {
  const scale = Math.min(1, mangaManifest.maxInputSide / Math.max(image.width, image.height),
    Math.sqrt(mangaManifest.maxInputPixels / (image.width * image.height)))
  return { width: Math.floor(image.width * scale), height: Math.floor(image.height * scale), resized: scale < 1 }
}
export async function prepareMangaImage(image: MangaImage, resize: boolean): Promise<Blob> {
  const size = mangaInputSize(image)
  if (!size.resized) return image.blob
  if (!resize) throw new Error('图片超过处理上限，请勾选缩小处理副本后再试')
  if (Math.min(size.width, size.height) < mangaManifest.minInputSide) throw new Error('图片比例过长，缩小后不足 128 像素，请先裁切图片')
  const bitmap = await createImageBitmap(image.blob)
  try {
    const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法准备处理副本，请重新打开窗口')
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size.width, size.height); ctx.drawImage(bitmap, 0, 0, size.width, size.height)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('处理副本编码失败')), 'image/png'))
  } finally { bitmap.close() }
}

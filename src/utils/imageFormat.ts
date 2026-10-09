import { isPng } from './pngMetadata'

export function imageFormat(buffer: ArrayBuffer): { ext: string; mime: string } {
  if (isPng(buffer)) return { ext: 'png', mime: 'image/png' }
  const bytes = new Uint8Array(buffer)
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { ext: 'jpg', mime: 'image/jpeg' }
  const text = new TextDecoder().decode(bytes.subarray(0, 12))
  if (text.startsWith('RIFF') && text.slice(8) === 'WEBP') return { ext: 'webp', mime: 'image/webp' }
  if (/^GIF8[79]a/.test(text)) return { ext: 'gif', mime: 'image/gif' }
  if (text.startsWith('BM')) return { ext: 'bmp', mime: 'image/bmp' }
  if (text.slice(4, 8) === 'ftyp' && /^avi[fs]$/.test(text.slice(8, 12))) return { ext: 'avif', mime: 'image/avif' }
  throw new Error('原图格式无法识别，请重新导入有效图片')
}

/** Apply a detected MIME, or repair absent metadata, without changing image bytes. */
export async function withImageMime(blob: Blob, mime = blob.type): Promise<Blob> {
  const type = mime && mime !== 'application/octet-stream' ? mime : imageFormat(await blob.slice(0, 12).arrayBuffer()).mime
  if (blob.type === type) return blob
  if (blob instanceof File) return new File([blob], blob.name, { type, lastModified: blob.lastModified })
  return blob.slice(0, blob.size, type)
}

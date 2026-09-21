/** Header-only preflight before browser codecs allocate pixels. Unknown formats
 * may remain stored originals, but are not decoded to create thumbnails. */
export async function withinImageDecodeBudget(blob: Blob): Promise<boolean> {
  if (!blob.size || blob.size > 20 * 1024 * 1024) return false
  const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer)
  const text = (at: number, n: number) => String.fromCharCode(...bytes.subarray(at, at + n))
  let width = 0, height = 0
  try {
    if (text(1, 3) === 'PNG') {
      width = view.getUint32(16); height = view.getUint32(20)
      for (let at = 8; at + 12 <= bytes.length;) {
        if (text(at + 4, 4) === 'acTL') return false
        const size = view.getUint32(at); if (at + 12 + size > bytes.length) return false
        at += 12 + size
      }
    } else if (bytes[0] === 255 && bytes[1] === 216) {
      for (let at = 2; at + 9 < bytes.length;) {
        if (bytes[at] !== 255) { at++; continue }
        const marker = bytes[at + 1]
        if (marker === 216 || marker >= 208 && marker <= 215 || marker === 1) { at += 2; continue }
        const size = view.getUint16(at + 2)
        if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) { height = view.getUint16(at + 5); width = view.getUint16(at + 7); break }
        if (size < 2) return false
        at += 2 + size
      }
    } else if (text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
      const format = text(12, 4)
      if (format === 'VP8X') {
        if (bytes[20] & 2) return false
        width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16)
        height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)
      } else if (format === 'VP8 ') { width = view.getUint16(26, true) & 16383; height = view.getUint16(28, true) & 16383 }
      else if (format === 'VP8L') { const bits = view.getUint32(21, true); width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1 }
    }
  } catch { return false }
  return width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 32 * 1024 * 1024
}

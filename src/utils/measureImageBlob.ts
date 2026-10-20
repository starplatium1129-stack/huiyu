/** Read dimensions without retaining decoded pixels or temporary object URLs. */
export async function measureImageBlob(blob: Blob): Promise<{ width: number | null; height: number | null }> {
  try {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob)
      try { return { width: bitmap.width, height: bitmap.height } }
      finally { bitmap.close() }
    }
  } catch { /* Use the image element decoder when bitmap decoding is unavailable. */ }
  return new Promise(resolve => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    const finish = (width: number | null, height: number | null) => {
      img.onload = img.onerror = null
      img.removeAttribute('src')
      URL.revokeObjectURL(url)
      resolve({ width, height })
    }
    img.onload = () => finish(img.naturalWidth || null, img.naturalHeight || null)
    img.onerror = () => finish(null, null)
    img.src = url
  })
}

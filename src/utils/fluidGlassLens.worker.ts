export interface LensDimensions {
  width: number
  height: number
  radius: number
  rim: number
}

/** Encode a rounded lens into red/green offsets; its centre stays undistorted.
 * This is a small geometry texture, never a screenshot or a copy of UI content. */
async function lensMap({ width, height, radius, rim }: LensDimensions) {
  const ratio = Math.min(1, 1024 / width, 768 / height, Math.sqrt(180000 / (width * height)))
  const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(width * ratio)), Math.max(1, Math.ceil(height * ratio)))
  const context = canvas.getContext('2d')
  if (!context) return
  const pixels = context.createImageData(canvas.width, canvas.height)
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const px = (x + .5) * width / canvas.width - width / 2
      const py = (y + .5) * height / canvas.height - height / 2
      const qx = Math.abs(px) - (width / 2 - radius), qy = Math.abs(py) - (height / 2 - radius)
      const cx = Math.max(qx, 0), cy = Math.max(qy, 0), length = Math.hypot(cx, cy)
      const depth = -(length + Math.min(Math.max(qx, qy), 0) - radius)
      const bend = Math.pow(1 - Math.max(0, Math.min(1, depth / rim)), 1.8)
      const nx = length > 0 ? cx / length : qx >= qy ? 1 : 0
      const ny = length > 0 ? cy / length : qy > qx ? 1 : 0
      const index = (y * canvas.width + x) * 4
      pixels.data[index] = Math.round(128 - Math.sign(px) * nx * bend * 127)
      pixels.data[index + 1] = Math.round(128 - Math.sign(py) * ny * bend * 127)
      pixels.data[index + 2] = 128; pixels.data[index + 3] = 255
    }
  }
  context.putImageData(pixels, 0, 0)
  const png = await canvas.convertToBlob({ type: 'image/png' })
  const reader = new FileReader()
  return new Promise<string>((resolve, reject) => {
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(png)
  })
}

self.onmessage = async (event: MessageEvent<LensDimensions>) => {
  try { self.postMessage(await lensMap(event.data) ?? null) }
  catch { self.postMessage(null) }
}

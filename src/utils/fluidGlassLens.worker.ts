export interface LensDimensions {
  width: number
  height: number
  radius: number
  rim: number
}

/** Encode a convex liquid-glass bezel into red/green displacement offsets.
 * The bevel bends smoothly like a thick water droplet while the reading center
 * stays optically flat so text remains sharp. */
async function lensMap({ width, height, radius, rim }: LensDimensions) {
  const ratio = Math.min(1, 1024 / width, 768 / height, Math.sqrt(200000 / (width * height)))
  const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(width * ratio)), Math.max(1, Math.ceil(height * ratio)))
  const context = canvas.getContext('2d')
  if (!context) return
  const pixels = context.createImageData(canvas.width, canvas.height)
  const halfW = width / 2
  const halfH = height / 2
  const innerW = Math.max(0, halfW - radius)
  const innerH = Math.max(0, halfH - radius)

  for (let y = 0; y < canvas.height; y++) {
    const py = (y + .5) * height / canvas.height - halfH
    const qy = Math.abs(py) - innerH
    const cy = Math.max(qy, 0)
    for (let x = 0; x < canvas.width; x++) {
      const px = (x + .5) * width / canvas.width - halfW
      const qx = Math.abs(px) - innerW
      const cx = Math.max(qx, 0)
      const length = Math.hypot(cx, cy)
      const depth = -(length + Math.min(Math.max(qx, qy), 0) - radius)

      let dx = 0
      let dy = 0
      if (depth >= 0 && depth < rim) {
        // Polished crystal bevel: C2-smooth cubic falloff concentrated in the outer rim
        // so the reading center remains 100% optically flat and distortion-free.
        const u = 1 - depth / rim
        const bend = u * u * (3 - 2 * u) * u
        const nx = length > 0 ? cx / length : qx >= qy ? 1 : 0
        const ny = length > 0 ? cy / length : qy > qx ? 1 : 0
        dx = Math.sign(px) * nx * bend
        dy = Math.sign(py) * ny * bend
      }

      const index = (y * canvas.width + x) * 4
      pixels.data[index] = Math.round(128 - dx * 127)
      pixels.data[index + 1] = Math.round(128 - dy * 127)
      pixels.data[index + 2] = 128
      pixels.data[index + 3] = 255
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

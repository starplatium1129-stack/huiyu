/** Sample the displayed image once; an unreadable image simply has no ambient palette. */
export function sampleCanvasAmbient(image: HTMLImageElement): string[] {
  if (!image.complete || !image.naturalWidth || !image.naturalHeight) return []

  const canvas = image.ownerDocument.createElement('canvas')
  const scale = Math.min(1, 40 / Math.max(image.naturalWidth, image.naturalHeight))
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return []
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    const groups = Array.from({ length: 3 }, () => ({ red: 0, green: 0, blue: 0, count: 0 }))
    for (let offset = 0; offset < data.length; offset += 4) {
      const red = data[offset], green = data[offset + 1], blue = data[offset + 2]
      if (data[offset + 3] < 128 || Math.max(red, green, blue) < 24 || Math.min(red, green, blue) > 232) continue
      const column = (offset / 4) % canvas.width
      const group = groups[Math.min(2, Math.floor(column * 3 / canvas.width))]
      group.red += red; group.green += green; group.blue += blue; group.count++
    }
    const total = groups.reduce((sum, group) => ({
      red: sum.red + group.red, green: sum.green + group.green,
      blue: sum.blue + group.blue, count: sum.count + group.count,
    }), { red: 0, green: 0, blue: 0, count: 0 })
    if (!total.count) return []
    return groups.map(group => {
      const color = group.count ? group : total
      return `${Math.round(color.red / color.count)} ${Math.round(color.green / color.count)} ${Math.round(color.blue / color.count)}`
    })
  } catch {
    // Local images remain fully usable if browser canvas access is unavailable or tainted.
    return []
  } finally {
    canvas.width = 0; canvas.height = 0
  }
}

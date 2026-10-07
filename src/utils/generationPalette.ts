/** Three dominant pigments from the whole decoded work, sampled once at <=40px.
 * Alpha, coverage and saturation keep white margins from drowning out the art. */
export function sampleGenerationPalette(image: HTMLImageElement): string[] {
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
    const buckets = new Map<number, { red: number; green: number; blue: number; weight: number }>()
    for (let offset = 0; offset < data.length; offset += 4) {
      const red = data[offset], green = data[offset + 1], blue = data[offset + 2]
      const high = Math.max(red, green, blue), low = Math.min(red, green, blue)
      const weight = data[offset + 3] / 255 * (.25 + (high - low) / Math.max(high, 1) * 2)
        * (high < 24 || low > 240 ? .08 : 1)
      if (!weight) continue
      const key = (red >> 5) * 64 + (green >> 5) * 8 + (blue >> 5)
      const bucket = buckets.get(key) ?? { red: 0, green: 0, blue: 0, weight: 0 }
      bucket.red += red * weight; bucket.green += green * weight; bucket.blue += blue * weight; bucket.weight += weight
      buckets.set(key, bucket)
    }
    const selected: number[][] = []
    for (const bucket of [...buckets.values()].sort((a, b) => b.weight - a.weight)) {
      const color = [bucket.red, bucket.green, bucket.blue].map(channel => Math.round(channel / bucket.weight))
      if (selected.every(previous => color.reduce((distance, channel, index) => distance + (channel - previous[index]) ** 2, 0) >= 55 ** 2)) selected.push(color)
      if (selected.length === 3) break
    }
    if (!selected.length) return []
    while (selected.length < 3) selected.push([...selected[selected.length - 1]])
    return selected.map(color => color.join(' '))
  } catch { return [] }
  finally { canvas.width = canvas.height = 0 }
}

/** Keep the sampled hue, adjusting lightness only for the canvas theme. */
export function visibleGenerationPigment(color: string, light: boolean): string {
  const channels = color.split(' ').map(Number)
  const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
  const target = Math.max(light ? 48 : 135, Math.min(light ? 102 : 210, luminance))
  return channels.map(channel => Math.round(luminance > target ? channel * target / luminance
    : channel + (255 - channel) * (target - luminance) / (255 - luminance))).join(' ')
}

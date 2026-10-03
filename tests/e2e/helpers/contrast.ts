import type { Locator } from '@playwright/test'

/** Runs in the browser; preserves CSS group opacity while compositing each ancestor. */
export function textContrast(element: Element, pseudo: string | null = null): number {
  type Color = [number, number, number, number]
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  const parse = (color: string): Color => {
    if (!CSS.supports('color', color)) throw new Error(`Unsupported color: ${color}`)
    context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
    return [r, g, b, a / 255]
  }
  const over = (front: Color, back: Color): Color => {
    const alpha = front[3] + back[3] * (1 - front[3])
    if (!alpha) return [0, 0, 0, 0]
    return [0, 1, 2].map(i => (front[i] * front[3] + back[i] * back[3] * (1 - front[3])) / alpha).concat(alpha) as Color
  }
  const luminance = (color: Color) => color.slice(0, 3).map(value => {
    const v = value / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4
  }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0)
  let foreground = parse(getComputedStyle(element, pseudo).color)
  let background: Color = [0, 0, 0, 0]
  const layer = (style: CSSStyleDeclaration) => {
    if (style.backgroundImage !== 'none' && background[3] < .999) {
      throw new Error('Image backgrounds need pixel sampling and visual review')
    }
    const surface = parse(style.backgroundColor)
    foreground = over(foreground, surface); background = over(background, surface)
    // Opacity applies to the complete group, including its background and descendants.
    const opacity = Number(style.opacity)
    foreground[3] *= opacity; background[3] *= opacity
  }
  if (pseudo) layer(getComputedStyle(element, pseudo))
  for (let node: Element | null = element; node; node = node.parentElement) layer(getComputedStyle(node))
  const viewport: Color = [255, 255, 255, 1]
  const a = luminance(over(foreground, viewport)), b = luminance(over(background, viewport))
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
}

/** Actual painted backgrounds for leaf text in opaque, unfiltered groups.
 * Group opacity stays with textContrast; unsupported paint effects must be reviewed visually.
 */
export async function paintedTextContrast(locator: Locator): Promise<number> {
  await locator.scrollIntoViewIfNeeded()
  await locator.evaluate(async element => {
    const animations: Animation[] = []
    for (let node: Element | null = element; node; node = node.parentElement) {
      animations.push(...node.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity))
    }
    await Promise.all(animations.map(animation => animation.finished.catch(() => {})))
  })
  const measurement = await locator.evaluate(element => {
    if (element.children.length) throw new Error('Pixel contrast requires leaf text')
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (Number(style.opacity) !== 1 || style.filter !== 'none' || style.backdropFilter !== 'none' || style.mixBlendMode !== 'normal') {
        throw new Error('Filtered or translucent groups require a visual contrast review')
      }
    }
    const style = getComputedStyle(element)
    const fill = style.getPropertyValue('-webkit-text-fill-color')
    if ((fill && fill !== style.color) || parseFloat(style.getPropertyValue('-webkit-text-stroke-width')) > 0 || style.textShadow !== 'none') {
      throw new Error('Special text paint requires a visual contrast review')
    }
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')!
    context.fillStyle = getComputedStyle(element).color; context.fillRect(0, 0, 1, 1)
    const foreground = [...context.getImageData(0, 0, 1, 1).data]
    const bounds = element.getBoundingClientRect()
    const range = document.createRange(); range.selectNodeContents(element)
    const rects = [...range.getClientRects()].map(rect => ({ x: rect.x - bounds.x, y: rect.y - bounds.y, width: rect.width, height: rect.height }))
    if (!element.textContent?.trim() || !bounds.width || !bounds.height || !rects.length) throw new Error('No visible text to sample')
    return { foreground, rects, width: bounds.width, height: bounds.height, style: element.getAttribute('style') }
  })
  let screenshot: Buffer
  try {
    await locator.evaluate(element => {
      const style = (element as HTMLElement).style
      style.setProperty('color', 'transparent', 'important')
      style.setProperty('text-shadow', 'none', 'important')
    })
    screenshot = await locator.screenshot({ animations: 'disabled', scale: 'css' })
  } finally {
    await locator.evaluate((element, style) => {
      if (style === null) element.removeAttribute('style')
      else element.setAttribute('style', style)
    }, measurement.style)
  }
  return locator.evaluate(async (_element, { encoded, measurement }) => {
    const image = new Image(); image.src = `data:image/png;base64,${encoded}`; await image.decode()
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, image.width, image.height).data
    const luminance = (color: number[]) => color.map(value => {
      const v = value / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4
    }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0)
    const sx = image.width / measurement.width, sy = image.height / measurement.height
    const alpha = measurement.foreground[3] / 255
    let minimum = Infinity
    for (const rect of measurement.rects) {
      for (let y = Math.max(0, Math.floor(rect.y * sy) - 1); y < Math.min(image.height, Math.ceil((rect.y + rect.height) * sy) + 1); y++) {
        for (let x = Math.max(0, Math.floor(rect.x * sx) - 1); x < Math.min(image.width, Math.ceil((rect.x + rect.width) * sx) + 1); x++) {
          const offset = (y * image.width + x) * 4
          const background = Array.from(pixels.slice(offset, offset + 3))
          const foreground = background.map((value, i) => measurement.foreground[i] * alpha + value * (1 - alpha))
          const a = luminance(foreground), b = luminance(background)
          minimum = Math.min(minimum, (Math.max(a, b) + .05) / (Math.min(a, b) + .05))
        }
      }
    }
    if (!Number.isFinite(minimum)) throw new Error('No background pixels sampled')
    return minimum
  }, { encoded: screenshot!.toString('base64'), measurement })
}

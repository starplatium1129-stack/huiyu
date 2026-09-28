import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// These are CSS viewports at DPR 1 and browser zoom 100%, not physical-monitor
// or native WebView DPI certification. Every image is a neutral in-memory SVG.
test.use({ deviceScaleFactor: 1 })
const DISPLAYS = [[1920, 1080], [2560, 1440], [3840, 2160], [1280, 800]] as const
const IMAGES = [
  [1600, 900, 'both'], [800, 1200, 'both'], [1600, 900, 'none'], [800, 1200, 'width'],
  [1000, 1000, 'both'], [1800, 900, 'height'], [900, 1350, 'none'], [1600, 1000, 'both'],
  [800, 1200, 'both'], [1600, 900, 'none'], [1000, 1000, 'both'], [1200, 800, 'both'],
].map(([width, height, dimensions], index) => ({
  id: `image-layout-${String(index + 1).padStart(2, '0')}`,
  title: `布局样张 ${String(index + 1).padStart(2, '0')}`,
  width: Number(width), height: Number(height), dimensions,
  rating: index === 11 ? 'R18' : 'All',
}))

type Box = { x: number; y: number; width: number; height: number; right: number; bottom: number }

/** Object-fit can hide a large letterbox inside an apparently well-sized img.
 * Measure the painted source rectangle, including object-position and padding. */
function paintedImage(image: HTMLImageElement) {
  const style = getComputedStyle(image), rect = image.getBoundingClientRect()
  const number = (value: string) => parseFloat(value) || 0
  const left = number(style.borderLeftWidth) + number(style.paddingLeft)
  const top = number(style.borderTopWidth) + number(style.paddingTop)
  const width = rect.width - left - number(style.borderRightWidth) - number(style.paddingRight)
  const height = rect.height - top - number(style.borderBottomWidth) - number(style.paddingBottom)
  const box = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height, right: x + width, bottom: y + height })
  const content = box(rect.x + left, rect.y + top, width, height)
  const naturalWidth = image.naturalWidth, naturalHeight = image.naturalHeight
  const contain = Math.min(width / naturalWidth, height / naturalHeight)
  const scale = style.objectFit === 'cover' ? Math.max(width / naturalWidth, height / naturalHeight)
    : style.objectFit === 'none' ? 1 : style.objectFit === 'scale-down' ? Math.min(1, contain) : contain
  const paintedWidth = style.objectFit === 'fill' ? width : naturalWidth * scale
  const paintedHeight = style.objectFit === 'fill' ? height : naturalHeight * scale
  const position = style.objectPosition.split(/\s+/)
  const offset = (value: string, room: number) => value.endsWith('%') ? room * number(value) / 100
    : value === 'center' ? room / 2 : value === 'right' || value === 'bottom' ? room
      : value === 'left' || value === 'top' ? 0 : number(value)
  const painted = box(content.x + offset(position[0], width - paintedWidth),
    content.y + offset(position[1] || '50%', height - paintedHeight), paintedWidth, paintedHeight)
  return { content, painted, naturalWidth, naturalHeight }
}

function inside(inner: Box, outer: Box, label: string) {
  expect(inner.x, `${label}: left`).toBeGreaterThanOrEqual(outer.x - 2)
  expect(inner.y, `${label}: top`).toBeGreaterThanOrEqual(outer.y - 2)
  expect(inner.right, `${label}: right`).toBeLessThanOrEqual(outer.right + 2)
  expect(inner.bottom, `${label}: bottom`).toBeLessThanOrEqual(outer.bottom + 2)
}

async function box(locator: Locator): Promise<Box> {
  const bounds = (await locator.boundingBox())!
  return { ...bounds, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height }
}

async function installImages(page: Page, images = IMAGES) {
  const served: string[] = [], unexpected: string[] = []
  await page.route('**/scene-showcase/manifest.json', route => route.fulfill({ json: { entries: images.map(image => ({
    id: image.id, title: image.title, char: 'nene', type: 'scene', rating: image.rating,
    category: '中性布局夹具', story: '用于验证画幅与查看器排版的几何图形。',
    ...(image.dimensions === 'both' || image.dimensions === 'width' ? { width: image.width } : {}),
    ...(image.dimensions === 'both' || image.dimensions === 'height' ? { height: image.height } : {}),
  })) } }))
  // Never fall through to disk media, including the neutral sample marked R18.
  await page.route(/\/scene-showcase\/(?:images|thumbs)\/[^/?]+/, route => {
    const path = new URL(route.request().url()).pathname
    const image = images.find(item => path.endsWith(`/${item.id}.jpg`))
    if (!image) { unexpected.push(path); return route.fulfill({ status: 404, body: 'Unknown neutral fixture' }) }
    served.push(path)
    return route.fulfill({ contentType: 'image/svg+xml', body:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}" viewBox="0 0 ${image.width} ${image.height}">` +
      `<rect width="100%" height="100%" fill="#736987"/><rect x="8" y="8" width="${image.width - 16}" height="${image.height - 16}" fill="none" stroke="#e1e5ef" stroke-width="12"/>` +
      `<circle cx="${image.width / 2}" cy="${image.height / 2}" r="${Math.min(image.width, image.height) / 4}" fill="#c6d9d6"/>` +
      '<path d="M36 36h100M36 36v100" stroke="#e1e5ef" stroke-width="10"/></svg>' })
  })
  return { served, unexpected }
}

for (const theme of ['light', 'dark']) {
  test(`extreme aspect ratios keep preview controls reachable ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    const images = [
      { ...IMAGES[0], id: 'tall-reference', width: 200, height: 1600 },
      { ...IMAGES[1], id: 'panoramic-reference', width: 1600, height: 200 },
    ]
    await installImages(page, images)
    await page.goto('/showcase?scene=tall-reference')
    const dialog = page.locator('.showcase-viewer')
    for (const entry of images) {
      const image = dialog.locator('.zoomable-img')
      await expect(image).toHaveAttribute('src', new RegExp(`/images/${entry.id}\\.jpg`))
      await expect(image).toHaveJSProperty('naturalWidth', entry.width)
      const viewport = await box(dialog.locator('.zoom-viewport'))
      const toolbar = await box(dialog.locator('.zoom-toolbar'))
      inside((await image.evaluate(paintedImage)).painted, viewport, 'complete extreme-ratio reference')
      inside(toolbar, await box(dialog.locator('.viewer-art')), 'extreme-ratio toolbar')
      for (const button of await dialog.locator('.zoom-control').all()) inside(await box(button), toolbar, 'extreme-ratio zoom action')
      expect(toolbar.y).toBeGreaterThanOrEqual(viewport.bottom - 2)
      await page.screenshot({ path: info.outputPath(`${entry.id}-${theme}.png`) })
      await dialog.getByRole('button', { name: '下一张', exact: true }).click()
    }
  })
}

test.describe('primary display effective space at 200 percent scaling', () => {
  // The measured host is 2880×1800 at 200%; use its effective CSS space as well
  // as DPR 2. Native window decorations and WebView rendering remain separate.
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  for (const theme of ['light', 'dark']) {
    test(`scaled desktop preview ${theme}`, async ({ page }, info) => {
      const directory = info.outputPath('scaled-desktop')
      await mkdir(directory, { recursive: true })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
      await installImages(page)
      await page.goto('/showcase')
      expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, zoom: visualViewport?.scale })))
        .toEqual({ width: 1440, height: 900, dpr: 2, zoom: 1 })
      await page.locator('.sample-visual').first().click()
      await fitFrame(page, 0, directory)
      await page.getByRole('button', { name: '下一张', exact: true }).click()
      await fitFrame(page, 1, directory)
    })
  }
})

async function measureWall(page: Page, directory: string) {
  const cards = page.locator('.showcase-grid .sample')
  await expect(cards).toHaveCount(IMAGES.length)
  // Native lazy loading must decode the missing-dimension entries before their
  // fallback ratios can settle. Scroll normally instead of forcing load state.
  for (const card of await cards.all()) {
    await card.scrollIntoViewIfNeeded()
    await expect(card.locator('.sample-image')).toHaveClass(/sample-image-ready/)
  }
  await page.mouse.move(0, 0)
  await page.evaluate(() => { scrollTo({ top: 0, behavior: 'instant' }); return document.fonts.ready })
  await expect.poll(() => cards.evaluateAll(elements => elements.every(element => {
    const image = element.querySelector<HTMLImageElement>('.sample-image')!
    const visual = element.querySelector('.sample-visual')!.getBoundingClientRect()
    return image.naturalWidth > 0 && Math.abs(visual.width / visual.height - image.naturalWidth / image.naturalHeight) < .015
  }))).toBe(true)

  const geometry = []
  for (const card of await cards.all()) {
    const id = (await card.getAttribute('data-sample-id'))!
    geometry.push({ id, card: await box(card), visual: await box(card.locator('.sample-visual')),
      image: await card.locator('.sample-image').evaluate(paintedImage) })
  }
  await writeFile(join(directory, 'wall-geometry.json'), JSON.stringify(geometry, null, 2))
  expect(geometry.map(item => item.id)).toEqual(IMAGES.map(item => item.id))
  const rows: typeof geometry[] = []
  for (const item of geometry) {
    const row = rows.find(row => Math.abs(row[0].visual.y - item.visual.y) <= 4)
    if (row) row.push(item)
    else rows.push([item])
    if (item.id !== IMAGES.at(-1)!.id) {
      inside(item.image.painted, item.image.content, `${item.id} source is not cropped`)
      inside(item.image.painted, item.visual, `${item.id} fits its thumbnail`)
      expect(Math.abs(item.image.painted.width / item.image.painted.height - item.image.naturalWidth / item.image.naturalHeight)).toBeLessThan(.015)
    }
  }
  const readingOrder = [...rows].sort((a, b) => a[0].visual.y - b[0].visual.y)
    .flatMap(row => [...row].sort((a, b) => a.visual.x - b.visual.x).map(item => item.id))
  expect(readingOrder).toEqual(IMAGES.map(item => item.id))
  expect(rows.length).toBeGreaterThan(1)
  expect(Math.abs(geometry[0].visual.y - geometry[1].visual.y)).toBeLessThanOrEqual(4)
  expect(geometry[0].visual.width / geometry[1].visual.width).toBeGreaterThan(2)
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    // Four CSS pixels allow the differing border/ratio fractions in flex rows.
    expect(Math.max(...row.map(item => item.visual.height)) - Math.min(...row.map(item => item.visual.height))).toBeLessThanOrEqual(4)
    expect(Math.max(...row.map(item => item.card.bottom)) - Math.min(...row.map(item => item.card.bottom))).toBeLessThanOrEqual(48)
    if (index + 1 < rows.length) {
      const nextTop = rows[index + 1][0].card.y
      expect(nextTop - Math.max(...row.map(item => item.card.bottom))).toBeLessThanOrEqual(48)
      expect(nextTop).toBeGreaterThanOrEqual(Math.max(...row.map(item => item.card.bottom)))
    }
  }
  return geometry
}

async function fitFrame(page: Page, index: number, directory: string) {
  const dialog = page.locator('.showcase-viewer'), image = dialog.locator('.zoomable-img')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.viewer-copy h2')).toHaveText(IMAGES[index].title)
  await expect(image).toHaveAttribute('src', new RegExp(`/images/${IMAGES[index].id}\\.jpg`))
  await expect(image).toHaveJSProperty('naturalWidth', IMAGES[index].width)
  await expect(dialog.locator('.zoom-level')).toHaveText('100%')
  await expect(dialog.locator('.zoom-toolbar .zoom-controls')).toBeVisible()
  await expect(dialog.locator('.zoom-toolbar .zoom-hint')).toHaveCount(1)
  const viewport = await box(dialog.locator('.zoom-viewport'))
  const toolbar = await box(dialog.locator('.zoom-toolbar'))
  const frame = await box(dialog.locator('.viewer-layout'))
  const art = await box(dialog.locator('.viewer-art'))
  const source = await image.evaluate(paintedImage)
  const state = { viewport, toolbar, frame, art, ...source }
  await writeFile(join(directory, `viewer-${index + 1}.json`), JSON.stringify(state, null, 2))
  inside(source.painted, source.content, 'fit source is uncropped')
  inside(source.painted, viewport, 'fit picture stays in its viewport')
  inside(toolbar, art, 'toolbar stays in art pane')
  const size = page.viewportSize()!
  inside(frame, { x: 0, y: 0, width: size.width, height: size.height, right: size.width, bottom: size.height }, 'viewer frame stays onscreen')
  expect(toolbar.y, 'toolbar begins below the image viewport').toBeGreaterThanOrEqual(viewport.bottom - 2)
  expect(toolbar.y, 'toolbar does not cover painted pixels').toBeGreaterThanOrEqual(source.painted.bottom - 2)
  const gaps = [source.painted.x - viewport.x, source.painted.y - viewport.y, viewport.right - source.painted.right, viewport.bottom - source.painted.bottom]
  expect(Math.max(...gaps), 'fit leaves only a small mat around the actual picture').toBeLessThanOrEqual(34)
  expect(Math.abs(source.painted.width / source.painted.height - IMAGES[index].width / IMAGES[index].height)).toBeLessThan(.015)
  for (const button of await dialog.locator('.zoom-control').all()) inside(await box(button), toolbar, 'zoom button is reachable below art')
  const hint = dialog.locator('.zoom-hint')
  if (await hint.isVisible()) inside(await box(hint), toolbar, 'visible hint stays below art')
  await page.screenshot({ path: join(directory, `viewer-${index + 1}.png`) })
  return state
}

for (const theme of ['light', 'dark'] as const) for (const [width, height] of DISPLAYS) {
  test(`showcase image layout ${theme} ${width}x${height}`, async ({ page }, info) => {
    const directory = resolve('runtime/showcase-image-layout-2026-09-28', `${Date.now()}-${process.pid}-${info.retry}`, `${theme}-${width}x${height}`)
    await mkdir(directory, { recursive: true })
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme })
    await page.addInitScript(value => {
      localStorage.setItem('aics_theme', value)
      localStorage.setItem('aics_guest_guide_dismissed', '1')
    }, theme)
    const media = await installImages(page)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/showcase')
    const environment = await page.evaluate(() => ({ cssWidth: innerWidth, cssHeight: innerHeight, dpr: devicePixelRatio,
      visualScale: visualViewport?.scale, browser: navigator.userAgent, systemDpi: 'not measured; desktop browser CSS viewport simulation' }))
    await writeFile(join(directory, 'environment.json'), JSON.stringify({ theme, ...environment }, null, 2))
    expect(environment).toMatchObject({ cssWidth: width, cssHeight: height, dpr: 1, visualScale: 1 })
    try {
      await measureWall(page, directory)
      await page.screenshot({ path: join(directory, 'wall.png') })
      const sensitive = page.locator(`.sample[data-sample-id="${IMAGES.at(-1)!.id}"]`)
      const blur = () => sensitive.locator('.sample-image').evaluate(element => Number(getComputedStyle(element).filter.match(/blur\(([\d.]+)px\)/)?.[1] || 0))
      await sensitive.scrollIntoViewIfNeeded()
      await page.mouse.move(0, 0)
      await expect.poll(blur).toBeGreaterThan(0)
      await expect(sensitive.locator('.sample-sensitive')).toBeVisible()
      await sensitive.locator('.sample-visual').focus()
      await expect.poll(blur).toBe(0)
      await page.getByRole('searchbox', { name: '搜索画册', exact: true }).focus()
      await expect.poll(blur).toBeGreaterThan(0)

      const opener = page.locator(`.sample[data-sample-id="${IMAGES[0].id}"] .sample-visual`)
      await opener.click()
      const landscape = await fitFrame(page, 0, directory)
      const dialog = page.locator('.showcase-viewer'), zoom = dialog.locator('.zoomable-image-viewer')
      const level = dialog.locator('.zoom-level')
      await dialog.getByRole('button', { name: '放大图片', exact: true }).click()
      await expect(level).not.toHaveText('100%')
      await dialog.getByRole('button', { name: '缩小图片', exact: true }).click()
      await expect(level).toHaveText('100%')
      await dialog.locator('.zoom-viewport').hover()
      await page.mouse.wheel(0, -120)
      await expect(level).not.toHaveText('100%')
      await zoom.focus()
      const transform = () => dialog.locator('.zoom-transform-layer').evaluate(element => {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
        return { x: matrix.e, y: matrix.f }
      })
      const before = await transform()
      await page.keyboard.press('ArrowRight')
      await expect.poll(async () => (await transform()).x).not.toBe(before.x)
      await expect(dialog.locator('.viewer-copy h2')).toHaveText(IMAGES[0].title)
      await page.keyboard.press('Home')
      await expect(level).toHaveText('100%')
      await expect.poll(transform).toEqual({ x: 0, y: 0 })
      await dialog.locator('.zoom-viewport').dblclick()
      await expect(level).not.toHaveText('100%')
      await dialog.getByRole('button', { name: '下一张', exact: true }).click()
      const portrait = await fitFrame(page, 1, directory)
      expect(portrait.frame.width).toBeLessThan(landscape.frame.width)
      expect(portrait.painted.height / portrait.painted.width).toBeGreaterThan(1)
      await dialog.getByRole('button', { name: '放大图片', exact: true }).click()
      await dialog.getByRole('button', { name: '下一张', exact: true }).click()
      await fitFrame(page, 2, directory)
      // At fit, arrows browse the same DOM order; while zoomed above they pan.
      await zoom.focus()
      await page.keyboard.press('ArrowLeft')
      await expect(dialog.locator('.viewer-copy h2')).toHaveText(IMAGES[1].title)
      await page.keyboard.press('ArrowLeft')
      await expect(dialog.locator('.viewer-copy h2')).toHaveText(IMAGES[0].title)
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(opener).toBeFocused()
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      expect(media.unexpected).toEqual([])
      expect(new Set(media.served.filter(path => path.includes('/thumbs/'))).size).toBe(IMAGES.length)
      expect(errors).toEqual([])
    } finally {
      await writeFile(join(directory, 'requests.json'), JSON.stringify({ ...media, errors }, null, 2))
      await page.screenshot({ path: join(directory, 'final-state.png') })
    }
  })
}

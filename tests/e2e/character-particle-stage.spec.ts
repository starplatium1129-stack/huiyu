import { expect, test } from '@playwright/test'
import { textContrast } from './helpers/contrast'

for (const theme of ['dark', 'light']) {
  for (const width of [1600, 390]) {
    test(`original particle style in the larger theatre ${theme} ${width}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1150 })
      await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
      await page.goto('/character?character=nene')
      const field = page.locator('.particle-theatre .has-portrait')
      await expect(field).toBeVisible()
      await expect(page.locator('.character-hero')).toHaveClass(/revealed/)
      const frame = await field.boundingBox()
      expect(frame!.height).toBeGreaterThanOrEqual(430)
      if (width === 1600) expect(frame!.width).toBeGreaterThan(1000)
      await expect(field).toHaveClass(/density-ambient/)
      await expect(field).not.toHaveClass(/is-bare/)
      const background = await field.evaluate(e => getComputedStyle(e).backgroundImage)
      // Portraits use a quiet light pool; grids and drafting frames compete with the dots.
      expect(background).toContain('radial-gradient')
      expect(background).not.toContain('linear-gradient')
      expect(await field.evaluate(e => getComputedStyle(e).backgroundSize)).not.toMatch(/\d+px/)
      expect(await field.evaluate(e => getComputedStyle(e, '::before').display)).toBe('none')
      await expect(field.locator('.particle-caption')).toHaveText('绫地宁宁')
      const pixels = await field.locator('canvas').evaluate(e => (e as HTMLCanvasElement).toDataURL())
      await page.mouse.move(frame!.x + frame!.width / 2, frame!.y + frame!.height / 2)
      await expect.poll(() => field.locator('canvas').evaluate(e => (e as HTMLCanvasElement).toDataURL())).not.toBe(pixels)
      await page.mouse.move(0, 0)
      for (const label of await page.locator('.portrait-stage-heading h2, .portrait-stage-kicker, .portrait-stage-footer p').all()) {
        // GPU drawing can finish before the page's entrance opacity transition.
        await expect.poll(() => label.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
      }
      await page.locator('.character-particle-stage').screenshot({ path: info.outputPath(`particles-${theme}-${width}.png`) })
      await page.getByRole('button', { name: '人物原画', exact: true }).focus()
      await page.keyboard.press('Enter')
      await expect(page.locator('.stage-original')).toBeVisible()
      await expect(page.locator('.portrait-image')).toBeVisible()
      await page.getByRole('button', { name: '粒子形象', exact: true }).click()
      await expect(field).not.toHaveClass(/is-static/)
      const before = await field.locator('canvas').evaluate(e => (e as HTMLCanvasElement).toDataURL())
      await expect.poll(() => field.locator('canvas').evaluate(e => (e as HTMLCanvasElement).toDataURL())).not.toBe(before)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    })
  }
}

test('switching characters keeps the original canvas and system motion behavior', async ({ page }) => {
  await page.goto('/character?character=nene')
  const field = page.locator('.particle-theatre .has-portrait')
  await expect(field).toBeVisible()
  await field.locator('canvas').evaluate(e => e.setAttribute('data-test-instance', 'retained'))
  await page.locator('.directory-item').filter({ hasText: '四季夏目' }).click()
  await expect(field).toHaveAttribute('aria-label', '四季夏目的人物粒子形象')
  await expect(field.locator('canvas')).toHaveAttribute('data-test-instance', 'retained')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(field).toHaveClass(/is-static/)
  const pixels = await field.locator('canvas').evaluate(e => (e as HTMLCanvasElement).toDataURL())
  await page.waitForTimeout(250)
  expect(await field.locator('canvas').evaluate(e => (e as HTMLCanvasElement).toDataURL())).toBe(pixels)
})

test('missing point cloud leaves original art and archive available', async ({ page }) => {
  await page.route('**/assets/particles/p_nene.json', route => route.fulfill({ status: 404 }))
  await page.goto('/character?character=nene')
  await expect(page.getByText('这位角色的粒子形象暂不可用，先欣赏人物原画。')).toBeVisible()
  await expect(page.getByRole('button', { name: '粒子形象', exact: true })).toBeDisabled()
  await expect(page.locator('.portrait-image')).toBeVisible()
  await expect(page.getByRole('link', { name: '以她开始绘制' })).toHaveAttribute('href', '/prompt-builder?char=nene')
})

test('portrait uses uncapped GPU drawing and survives context loss', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('aics_theme', 'light')
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, options?: unknown) {
      const context = original.call(this, kind, options as object)
      if (kind === 'webgl2') (window as unknown as { portraitGpu: WebGL2RenderingContext }).portraitGpu = context as WebGL2RenderingContext
      return context
    } as typeof original
  })
  await page.goto('/character?character=nene')
  const field = page.locator('.particle-theatre .has-portrait')
  await expect(field).toHaveAttribute('data-particle-renderer', 'webgl2')
  await expect(field).toHaveAttribute('data-particle-frame-limit', '0')
  await page.evaluate(() => (window as unknown as { portraitGpu: WebGL2RenderingContext }).portraitGpu.getExtension('WEBGL_lose_context')!.loseContext())
  await expect(field).toHaveAttribute('data-particle-renderer', 'canvas2d')
  const count = Number(await field.getAttribute('data-particle-count'))
  expect(count).toBeGreaterThan(1000)
  expect(await field.locator('canvas').evaluate(canvas => {
    const ctx = (canvas as HTMLCanvasElement).getContext('2d')!
    return ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data.some((value, index) => index % 4 === 3 && value > 0)
  })).toBe(true)
})

test('portrait remains available when WebGL is disabled', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, options?: unknown) {
      return kind === 'webgl2' ? null : original.call(this, kind, options as object)
    } as typeof original
  })
  await page.goto('/character?character=nene')
  const field = page.locator('.particle-theatre .has-portrait')
  await expect(field).toBeVisible()
  await expect(field).toHaveAttribute('data-particle-renderer', 'canvas2d')
  await expect(field).toHaveClass(/has-canvas/)
})

for (const theme of ['dark', 'light']) {
  test(`screen spacing survives enlargement and low-effects scheduling ${theme}`, async ({ page }) => {
    test.setTimeout(45000)
    await page.setViewportSize({ width: 1600, height: 1150 })
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.goto('/character?character=nene')
    const field = page.locator('.particle-theatre .has-portrait')
    await expect(field).toBeVisible()
    const theatre = page.locator('.particle-theatre')
    await theatre.evaluate(e => { (e as HTMLElement).style.height = '330px' })
    await expect.poll(async () => Number(await field.getAttribute('data-particle-count'))).toBeLessThan(6500)
    const referenceSpacing = Number(await field.getAttribute('data-particle-spacing'))
    const referenceCount = Number(await field.getAttribute('data-particle-count'))
    await theatre.evaluate(e => { (e as HTMLElement).style.height = '660px' })
    await expect.poll(async () => Number(await field.getAttribute('data-particle-count'))).toBeGreaterThan(referenceCount * 3.8)
    expect(Number(await field.getAttribute('data-particle-spacing'))).toBeCloseTo(referenceSpacing, 2)
    await page.evaluate(() => { document.documentElement.dataset.reducedGlass = 'true' })
    await page.waitForTimeout(1000)
    const lowCount = await field.getAttribute('data-particle-count')
    await page.waitForTimeout(10000)
    expect(await field.getAttribute('data-particle-count')).toBe(lowCount)
    expect(await field.getAttribute('data-particle-quality')).toBe('1')
  })
}

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
      // The original light theme deliberately removes the dark-theme grid.
      if (theme === 'dark') expect(background).toContain('linear-gradient')
      else expect(background).toBe('none')
      await expect(field.locator('.particle-caption')).toHaveText('绫地宁宁')
      const pixels = await field.locator('canvas').evaluate(e => (e as HTMLCanvasElement).toDataURL())
      await page.mouse.move(frame!.x + frame!.width / 2, frame!.y + frame!.height / 2)
      await expect.poll(() => field.locator('canvas').evaluate(e => (e as HTMLCanvasElement).toDataURL())).not.toBe(pixels)
      await page.mouse.move(0, 0)
      for (const label of await page.locator('.portrait-stage-heading h2, .portrait-stage-kicker, .portrait-stage-footer p').all()) {
        expect(await label.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
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

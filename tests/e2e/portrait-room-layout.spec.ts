import { expect, test } from '@playwright/test'

for (const theme of ['dark', 'light']) {
  test(`portrait preserves the full image with a separate caption in ${theme}`, async ({ page }, testInfo) => {
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.goto('/character?character=yuzuriha_inori')
    const image = page.locator('.portrait-image')
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
    await page.evaluate(() => document.fonts.ready)
    await expect(page.locator('.character-hero')).toHaveClass(/revealed/)
    await page.locator('.character-hero').evaluate(async el => { await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))) })
    const dimensions = await image.evaluate((el: HTMLImageElement) => {
      const rect = el.getBoundingClientRect(), parent = el.parentElement!
      return { fit: getComputedStyle(el).objectFit, gap: parent.clientWidth - rect.width,
        captionTop: parent.querySelector('.portrait-footer')!.getBoundingClientRect().top, bottom: rect.bottom }
    })
    expect(dimensions.fit).toBe('contain')
    expect(Math.abs(dimensions.gap)).toBeLessThan(2)
    expect(dimensions.captionTop).toBeGreaterThanOrEqual(dimensions.bottom - 1)
    await expect(page.locator('.portrait-source')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('portrait-' + theme + '.png') })
  })

  test(`live model retains a substantial stage when wardrobe opens in ${theme}`, async ({ page }) => {
    test.setTimeout(60000)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.goto('/chat')
    await page.getByRole('combobox', { name: '切换角色', exact: true }).selectOption('nene')
    const status = page.locator('.live2d-enable-cta')
    await expect(status).toBeEnabled()
    await status.click()
    await expect(page.locator('.portrait-stage')).toHaveClass(/live2d-ready/, { timeout: 45000 })
    await expect(page.locator('.live2d-host canvas')).toBeVisible()
    const before = await page.locator('.portrait-stage').boundingBox()
    expect(before!.height / page.viewportSize()!.height).toBeGreaterThan(0.4)
    await page.locator('.character-controls > summary').click()
    await page.locator('.wardrobe-trigger').click()
    await expect(page.locator('.wardrobe-menu')).toBeVisible()
    const after = await page.locator('.portrait-stage').boundingBox()
    expect(after!.height).toBeCloseTo(before!.height, 0)
    await page.locator('.wardrobe-trigger').click()
    await page.getByRole('combobox', { name: '切换角色', exact: true }).selectOption('natsume')
    await expect(page.locator('.portrait-stage[data-character="natsume"]')).toHaveClass(/live2d-ready/, { timeout: 45000 })
    await expect(page.locator('.avatar-status')).toHaveText('Live2D 已连接')
  })
}

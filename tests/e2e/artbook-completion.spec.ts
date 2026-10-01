import { expect, test } from '@playwright/test'
import { textContrast } from './helpers/contrast'
import { installSceneReferences } from './helpers/showcase'

for (const theme of ['dark', 'light']) {
  for (const [orientation, width, height] of [['portrait', 832, 1216], ['landscape', 1216, 832]] as const) {
    test(`scene reference preserves full composition ${orientation} ${theme}`, async ({ page }, info) => {
      await installSceneReferences(page)
      await page.route('**/scene-showcase/thumbs/sc003.jpg', route => route.fulfill({
        contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#746687"/><circle cx="${width / 2}" cy="${height / 2}" r="180" fill="#d5e1e2"/></svg>`,
      }))
      await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.goto('/prompt-builder?scene=sc003')
      const picture = page.locator('.scene-reference-picture')
      const image = picture.locator('img')
      await expect(image).toBeVisible()
      await expect.poll(() => image.evaluate(e => (e as HTMLImageElement).naturalWidth)).toBe(width)
      await expect(page.locator('.scene-reference-label')).toHaveText('场景参考 · 非本次生成')
      const assertComposition = async () => {
        const frame = await picture.boundingBox(), content = await image.boundingBox()
        expect(frame!.width / frame!.height).toBeCloseTo(width / height, 2)
        expect(Math.abs(content!.width - frame!.width)).toBeLessThanOrEqual(1)
        expect(Math.abs(content!.height - frame!.height)).toBeLessThanOrEqual(1)
        expect(await image.evaluate(e => getComputedStyle(e).objectFit)).toBe('contain')
      }
      const viewports = []
      for (const [viewportWidth, viewportHeight] of [[1920, 1080], [2560, 1440], [3840, 2160], [960, 900]]) {
        await page.setViewportSize({ width: viewportWidth, height: viewportHeight })
        await assertComposition()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        viewports.push(await page.evaluate(() => ({ cssViewport: [innerWidth, innerHeight], devicePixelRatio,
          visualViewportScale: visualViewport?.scale, physicalDisplay: 'not sampled in isolated browser' })))
        await page.screenshot({ path: info.outputPath(`scene-reference-${orientation}-${theme}-${viewportWidth}.png`) })
      }
      await info.attach('browser-viewports', { body: JSON.stringify(viewports), contentType: 'application/json' })
      await page.setViewportSize({ width: 1100, height: 720 })
      await assertComposition()
      expect((await picture.boundingBox())!.height).toBeLessThanOrEqual(180)
      await page.screenshot({ path: info.outputPath(`scene-reference-${orientation}-${theme}-short.png`) })
      for (const name of ['挑选场景', '导入图片换装', '从图片提取灵感']) {
        const action = page.locator('.stage-quick-actions').getByRole('button', { name, exact: true })
        await action.scrollIntoViewIfNeeded()
        await action.click({ trial: true })
      }
    })
  }
  test(`universal wardrobe collapses with keyboard and keeps selected clothing ${theme}`, async ({ page }, info) => {
    await installSceneReferences(page)
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/prompt-builder?scene=sc003')
    await page.getByRole('button', { name: '专家模式', exact: true }).click()
    await page.getByRole('tab', { name: '提示词', exact: true }).click()
    const wardrobe = page.locator('details.universal-wardrobe-section')
    const summary = wardrobe.locator('summary')
    const clothing = wardrobe.locator('.universal-outfit-btn').first()
    await expect(summary).toBeVisible()
    await expect(clothing).toBeHidden()
    await summary.focus()
    await page.keyboard.press('Enter')
    await expect(clothing).toBeVisible()
    await clothing.click()
    await expect(clothing).toHaveAttribute('aria-pressed', 'true')
    await summary.focus()
    await page.keyboard.press('Space')
    await expect(clothing).toBeHidden()
    for (const [width, height] of [[1920, 1080], [2560, 1440], [3840, 2160], [960, 900]]) {
      await page.setViewportSize({ width, height })
      await summary.scrollIntoViewIfNeeded()
      await expect(summary).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      for (const label of await summary.locator('strong, .wardrobe-expand').all()) expect(await label.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
      await page.screenshot({ path: info.outputPath(`wardrobe-collapsed-${theme}-${width}.png`) })
    }
    await summary.focus()
    await page.keyboard.press('Enter')
    await expect(clothing).toBeVisible()
    await expect(clothing).toHaveAttribute('aria-pressed', 'true')
    await page.screenshot({ path: info.outputPath(`wardrobe-open-${theme}.png`) })
  })
  for (const width of [1440]) {
    test(`reading hierarchy and notebook ${theme} ${width}`, async ({ page }, info) => {
      await installSceneReferences(page)
      await page.setViewportSize({ width, height: 1000 })
      await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.goto('/chat')
      await expect(page.locator('.stage-reference-caption')).toBeVisible()
      await expect(page.locator('.portrait-main')).toHaveAttribute('src', '/scene-showcase/thumbs/sc001.jpg')
      await page.goto('/color-script')
      await page.locator('.color-reading > summary').click()
      await expect(page.locator('.light-study')).toHaveCount(2)
      for (const choice of await page.locator('.comparison-choices button').all()) {
        await choice.click()
        await expect(choice).toHaveAttribute('aria-pressed', 'true')
        await expect(page.locator('.light-study')).toHaveCount(2)
      }
      for (const label of await page.locator('.study-label, .study-title, .reference-note').all()) {
        expect(await label.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
      }
      await page.locator('.study-mood').first().focus()
      await page.keyboard.press('Enter')
      await expect(page.locator('.mood-card.active')).toHaveCount(1)
      await page.screenshot({ path: info.outputPath(`palette-${theme}-${width}.png`), fullPage: false })
    })
  }

  test(`missing portrait keeps chat usable ${theme}`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.route('**/assets/characters/*-official.webp', route => route.abort())
    await page.route('**/scene-showcase/manifest.json', route => route.fulfill({ json: { entries: [] } }))
    await page.goto('/chat')
    await expect(page.getByText('立绘暂未加载，对话仍可继续')).toBeVisible()
    await expect(page.getByRole('button', { name: '重新加载立绘' })).toBeVisible()
    await expect(page.locator('.chat-input')).toBeVisible()
  })
  test(`unavailable reference keeps healthy original portrait ${theme}`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.route('**/scene-showcase/manifest.json', route => route.fulfill({ json: { entries: [] } }))
    await page.goto('/chat')
    await expect(page.locator('.portrait-main')).toHaveAttribute('src', '/assets/characters/nene-official.webp')
    await expect.poll(() => page.locator('.portrait-main').evaluate(e => (e as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await expect(page.locator('.stage-portrait-missing')).toHaveCount(0)
  })
}

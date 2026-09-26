import { expect, test } from '@playwright/test'
import { textContrast } from './helpers/contrast'
import { installSceneReferences } from './helpers/showcase'

for (const theme of ['dark', 'light']) {
  test(`scene reference preserves full composition ${theme}`, async ({ page }, info) => {
    await installSceneReferences(page)
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/prompt-builder?scene=sc003')
    const picture = page.locator('.scene-reference-picture')
    const image = picture.locator('img')
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate(e => (e as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await expect(page.locator('.scene-reference-label')).toHaveText('场景参考 · 非本次生成')
    const frame = await picture.boundingBox(), content = await image.boundingBox()
    expect(content!.height).toBeLessThanOrEqual(frame!.height + 1)
    expect(await image.evaluate(e => getComputedStyle(e).objectFit)).toBe('contain')
    await page.screenshot({ path: info.outputPath(`scene-reference-${theme}.png`) })
  })
  for (const width of [1440, 390]) {
    test(`reading hierarchy and notebook ${theme} ${width}`, async ({ page }, info) => {
      await installSceneReferences(page)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      for (const route of ['/', '/gallery', '/chat', '/character', '/color-script', '/video-studio', '/prompt-builder']) {
        await page.goto(route)
        await expect(page.locator('main')).toBeVisible()
        const ready: Record<string, string> = { '/': '.hero-character.is-current', '/gallery': '.archive-state-panel', '/chat': '.chat-input', '/character': '.character-bookshelf', '/color-script': '.light-notebook', '/video-studio': '.video-prompt', '/prompt-builder': '.stage-placeholder' }
        await expect(page.locator(ready[route])).toBeVisible()
        if (route === '/chat') {
          await expect(page.locator('.stage-reference-caption')).toBeVisible()
          await expect(page.locator('.portrait-main')).toHaveAttribute('src', '/scene-showcase/thumbs/sc001.jpg')
        }
        await page.evaluate(() => document.fonts.ready)
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
        await page.screenshot({ path: info.outputPath(`${route.replaceAll('/', '') || 'home'}-${theme}-${width}.png`), fullPage: false })
      }
      await page.goto('/color-script')
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

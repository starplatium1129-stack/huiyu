import { expect, test, type Locator, type Page } from '@playwright/test'
import { textContrast } from './helpers/contrast'

async function withinViewport(locator: Locator, page: Page) {
  await expect(locator).toBeVisible()
  const box = (await locator.boundingBox())!
  const viewport = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1)
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 768, 1024, 1440]) {
    test(`workbench tools and narrow reading flow ${theme} ${width}`, async ({ page }, info) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.setViewportSize({ width, height: width === 390 ? 844 : width === 1024 ? 720 : 960 })
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme })
      await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
      await page.goto('/prompt-builder')
      await expect(page.locator('.char-row')).toBeVisible()
      await expect(page.locator('.random-menu-trigger')).toBeEnabled()
      await page.evaluate(() => document.fonts.ready)
      await withinViewport(page.locator('.pb-topline'), page)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)

      // The larger text must not push the material chooser out of a phone's first screen.
      if (width === 390) {
        expect((await page.locator('.material-drawer').boundingBox())!.y).toBeLessThan(310)
        expect((await page.locator('#drawing-canvas').boundingBox())!.y).toBeLessThan(640)
        for (const selector of ['.focus-mode-btn', '.utility-trigger', '.random-menu-trigger', '.random-dice']) {
          const box = (await page.locator(selector).boundingBox())!
          expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44)
        }
      }
      await page.screenshot({ path: info.outputPath(`${theme}-${width}-basic.png`) })

      // Reflow must keep both existing popovers on screen and above the material panel.
      await page.locator('.random-menu-trigger').click()
      const random = page.getByRole('dialog', { name: '夏目的调色笔记', exact: true })
      await withinViewport(random, page)
      await random.locator('input[type="checkbox"]').click({ trial: true })
      await expect(random.locator('.random-undo')).toBeDisabled()
      await page.screenshot({ path: info.outputPath(`${theme}-${width}-random.png`) })
      await page.locator('.random-menu-trigger').click()
      await expect(random).toBeHidden()

      await page.locator('.utility-trigger').click()
      await withinViewport(page.locator('.utility-popover'), page)
      await page.getByRole('button', { name: '导出备份 JSON', exact: true }).click({ trial: true })
      await page.locator('.utility-trigger').click()

      if (width <= 900) {
        await page.getByRole('link', { name: '画布预览', exact: true }).click()
        await expect.poll(async () => (await page.locator('#drawing-canvas').boundingBox())!.y)
          .toBeGreaterThan((await page.locator('.nav').boundingBox())!.height)
        await page.getByRole('link', { name: '创作素材', exact: true }).click()
      }

      // Retain the search draft while switching modes and source controls.
      await page.locator('[aria-controls="material-scenes"]').click()
      await page.locator('#material-scenes .scene-search').fill('雨')
      await page.getByRole('button', { name: '专家模式', exact: true }).click()
      await expect(page.locator('#material-scenes .scene-search')).toHaveValue('雨')
      await page.locator('[aria-controls="material-character"]').click()
      const source = page.getByRole('button', { name: '热门角色 · 无需 LoRA', exact: true })
      await source.click({ trial: true })
      if (width >= 1024) {
        await withinViewport(page.locator('.gen-bar'), page)
        await withinViewport(page.locator('.director-inspector'), page)
        // Complete labels remain within their segment, including the 240px expert rail.
        const label = source.locator(':scope > span')
        const labelBox = (await label.boundingBox())!
        const sourceBox = (await source.boundingBox())!
        expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(sourceBox.x + sourceBox.width)
        const lineHeight = await label.evaluate(el => parseFloat(getComputedStyle(el).lineHeight))
        expect(labelBox.height).toBeLessThanOrEqual(lineHeight * 2 + 1)
      }
      await page.screenshot({ path: info.outputPath(`${theme}-${width}-expert.png`) })
      expect(errors).toEqual([])
    })
  }

  test(`workbench secondary text stays readable with solid glass ${theme}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript(theme => {
      localStorage.setItem('atelier-desktop-appearance-v1', JSON.stringify({ theme, motion: 'reduce', reducedGlass: true }))
    }, theme)
    await page.goto('/prompt-builder')
    await expect(page.locator('.gen-bar')).toBeVisible()
    for (const selector of ['.gen-bar-preset', '.gen-bar-blocked', '.material-heading', '.material-switch button:not([aria-pressed="true"])']) {
      const element = page.locator(selector).first()
      await expect(element).toBeVisible()
      expect(await element.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(13)
      expect(await element.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
    }
  })
}

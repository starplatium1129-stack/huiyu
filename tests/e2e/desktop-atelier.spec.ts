import { expect, test } from '@playwright/test'

const base = process.env.AICS_UI_AUDIT_URL || ''
for (const theme of ['dark', 'light']) {
  test.describe(`desktop atelier ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1366, height: 900 })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    })
    if (theme === 'dark') test('home visual character choice keeps the creation entry and selected room', async ({ page }) => {
      await page.goto(base + '/')
      await page.getByRole('button', { name: '四季夏目', exact: true }).click()
      await expect(page.getByRole('button', { name: '四季夏目', exact: true })).toHaveAttribute('aria-pressed', 'true')
      const create = page.getByRole('link', { name: '选场景，开始创作', exact: true })
      await expect(create).toHaveAttribute('href', '/scene-explorer')
      await expect(page.locator('.tool-card[href="/chat?character=natsume"]')).toHaveCount(1)
      await create.click()
      await expect(page).toHaveURL(/\/scene-explorer$/)
      await expect(page.locator('.scene-grid .sc').first()).toBeVisible()
      await page.goBack()
      // The home visual selection is local to this view, rather than a saved character preference.
      await page.getByRole('button', { name: '四季夏目', exact: true }).click()
      await page.locator('.tool-card[href="/chat?character=natsume"]').click()
      await expect(page).toHaveURL(/\/chat\?character=natsume$/)
      await expect(page.locator('.portrait-stage')).toHaveAttribute('data-character', 'natsume')
    })
    if (theme === 'dark') test('adjusting a scene never silently submits generation', async ({ page }) => {
      const submitted: string[] = []
      page.on('request', request => {
        if (request.method() === 'POST' && /txt2img|\/generate|\/generation/.test(request.url())) submitted.push(request.url())
      })
      await page.goto(base + '/scene-explorer')
      await page.locator('.scene-grid').getByRole('button', { name: '故事', exact: true }).first().click()
      const adjust = page.getByRole('link', { name: '进入工作台调整', exact: true })
      await expect(adjust).not.toHaveAttribute('href', /generate=1|quick=1/)
      await adjust.click()
      await expect(page.locator('.gen-bar')).toBeVisible()
      await page.locator('[aria-controls="material-story"]').click()
      await expect(page.locator('.scene-context-title')).toBeVisible()
      expect(submitted).toEqual([])
    })
    test('expert canvas is wider than either rail and fits the desktop', async ({ page }) => {
      await page.goto(base + '/prompt-builder')
      await page.getByRole('button', { name: '专家模式', exact: true }).click()
      await expect(page.locator('.director-inspector')).toBeVisible()
      const canvas = (await page.locator('.col-center').boundingBox())!
      const materials = (await page.locator('#drawing-materials').boundingBox())!
      const inspector = (await page.locator('.director-inspector').boundingBox())!
      expect(canvas.width).toBeGreaterThan(inspector.width)
      expect(canvas.width).toBeGreaterThan(materials.width)
      expect(canvas.x).toBeGreaterThanOrEqual(materials.x + materials.width)
      expect(inspector.x).toBeGreaterThanOrEqual(canvas.x + canvas.width)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    })
    if (theme === 'dark') test('room settings are discoverable without occupying the default conversation', async ({ page }) => {
      await page.goto(base + '/chat')
      await expect(page.locator('.room-model-settings')).toBeVisible()
      await expect(page.locator('.provider-switch')).toBeHidden()
      await page.locator('.room-model-settings summary').click()
      await expect(page.locator('.provider-switch')).toBeVisible()
      await page.locator('.room-model-settings summary').click()
      await expect(page.locator('.provider-switch')).toBeHidden()
    })
  })
}

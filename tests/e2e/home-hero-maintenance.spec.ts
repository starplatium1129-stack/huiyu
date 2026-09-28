import { expect, test, type Page } from '@playwright/test'
import sharp from 'sharp'
import { GUEST_GUIDE_DISMISSED_KEY, THEME_KEY } from '../../src/utils/storageKeys'

// The standard mock-stack owns the disposable Rust runtime and showcase directory.
// Real upload/reset requests below never use an operator profile or external base URL.
test.use({ serviceWorkers: 'block' })
test.beforeEach(async ({ page }) => {
  await page.addInitScript(key => localStorage.setItem(key, '1'), GUEST_GUIDE_DISMISSED_KEY)
  await page.emulateMedia({ reducedMotion: 'reduce' })
})
const characters = [{ id: 'nene', title: '宁宁' }, { id: 'natsume', title: '夏目' }] as const
async function openMaintenance(page: Page) {
  await page.goto('/scene-manager')
  await page.getByRole('navigation', { name: '维护分区' }).getByRole('button', { name: '样张', exact: true }).click()
}
async function selectHero(page: Page, character: typeof characters[number]) {
  const section = page.locator('.home-hero-maintenance')
  await section.locator('.sm-image-card').filter({ hasText: `首页 · ${character.id}` }).click()
  await expect(section.locator('.home-hero-preview')).toBeVisible()
  return section
}
async function loaded(page: Page, selector: string) {
  await expect.poll(() => page.locator(selector).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
}

for (const theme of ['dark', 'light']) {
  for (const [width, height] of [[1280, 800], [1440, 900], [1920, 1080], [2560, 1440], [3840, 2160]]) {
    test(`current covers agree with maintenance ${theme} ${width}x${height}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height })
      await page.addInitScript(({ key, theme }) => localStorage.setItem(key, theme), { key: THEME_KEY, theme })
      let legacyImageRequests = 0
      page.on('request', request => { if (request.url().includes('/scene-showcase/home/')) legacyImageRequests++ })
      // Reproduce an older installed runtime returning the dated showcase manifest.
      await page.route('**/api/maintenance/home-hero', route => route.fulfill({ json: {
        ok: true, version: 9, entries: Object.fromEntries(characters.map(({ id }) => [id, {
          image: `/scene-showcase/home/${id}.jpg?v=old`, updatedAt: '2026-08-15T03:41:18.363Z',
        }])),
      } }))
      await page.goto('/')
      for (const { id } of characters) {
        await expect(page.locator(`.hero-character.${id}`)).toHaveAttribute('src', `/assets/characters/${id}-home-cg-1024.webp`)
        await loaded(page, `.hero-character.${id}`)
      }
      await page.locator('.home-hero').screenshot({ path: info.outputPath('home.png') })
      await openMaintenance(page)
      for (const character of characters) {
        const section = await selectHero(page, character)
        await expect(section.locator('.home-hero-preview')).toHaveAttribute('src', `/assets/characters/${character.id}-home-cg-1024.webp`)
        await loaded(page, '.home-hero-preview')
        const bounds = await section.locator('.home-hero-preview').boundingBox()
        expect(bounds!.width).toBeLessThanOrEqual(520)
        expect(bounds!.height).toBeLessThanOrEqual(height * 0.6 + 1)
        await expect(section.locator('.sm-image-card.active')).toContainText('使用内置图')
        await expect(section.getByRole('button', { name: '上传 / 替换', exact: true })).toBeInViewport()
        await expect(section.getByRole('button', { name: '恢复内置图', exact: true })).toBeInViewport()
        if (character.id === 'nene') await section.screenshot({ path: info.outputPath('maintenance.png') })
      }
      expect(legacyImageRequests).toBe(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await info.attach('viewport', { contentType: 'application/json', body: JSON.stringify(await page.evaluate(() => ({
        cssWidth: innerWidth, cssHeight: innerHeight, devicePixelRatio, viewportScale: visualViewport?.scale,
        environment: 'Headless Edge CSS viewport; no physical display or Windows DPI acceptance',
      }))) })
    })
  }
}

test('real Rust upload and reset keep each hero and maintenance preview in sync', async ({ page }) => {
  test.setTimeout(90_000)
  const png = await sharp({ create: { width: 160, height: 210, channels: 3, background: '#74aba1' } }).png().toBuffer()
  for (const character of characters) {
    await openMaintenance(page)
    const section = await selectHero(page, character)
    const savedResponse = page.waitForResponse(response => response.url().endsWith('/api/maintenance/home-hero') && response.request().method() === 'POST')
    await section.locator('input[type=file]').setInputFiles({ name: 'neutral-hero.png', mimeType: 'image/png', buffer: png })
    expect((await savedResponse).ok()).toBe(true)
    await expect(section.locator('.sm-image-card.active')).toContainText('已替换')
    const custom = await section.locator('.home-hero-preview').getAttribute('src')
    expect(custom).toMatch(new RegExp(`/scene-showcase/home/${character.id}\\.jpg\\?v=`))
    await loaded(page, '.home-hero-preview')
    await page.goto('/')
    await expect(page.locator(`.hero-character.${character.id}`)).toHaveAttribute('src', custom!)
    await loaded(page, `.hero-character.${character.id}`)
    await openMaintenance(page)
    await selectHero(page, character)
    await expect(section.locator('.home-hero-preview')).toHaveAttribute('src', custom!)
    await section.getByRole('button', { name: '恢复内置图', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click()
    await expect(section.locator('.sm-image-card.active')).toContainText('使用内置图')
    await expect(section.locator('.home-hero-preview')).toHaveAttribute('src', `/assets/characters/${character.id}-home-cg-1024.webp`)
    await loaded(page, '.home-hero-preview')
    await page.goto('/')
    await expect(page.locator(`.hero-character.${character.id}`)).toHaveAttribute('src', `/assets/characters/${character.id}-home-cg-1024.webp`)
    await loaded(page, `.hero-character.${character.id}`)
  }
})

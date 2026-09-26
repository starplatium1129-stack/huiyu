import { installDesktopHostFixture } from './helpers/desktopHost'
import { expect, test } from '@playwright/test'
import type { CompanionDesktopBridge } from '../../src/types/desktop'
import { DESKTOP_START_PAGE_KEY, GUEST_GUIDE_DISMISSED_KEY, THEME_KEY } from '../../src/utils/storageKeys'
import { pickStudioOptionByValue } from './helpers/studioSelect'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(key => {
    localStorage.setItem(key, '1')
    window.desktopCapabilitiesFixture = {
      isDesktop: true,
      getWindowState: async () => ({ maximized: false, focused: true }),
      onMaximizedChanged: () => 1,
      offMaximizedChanged: () => {},
      minimizeWindow: () => {}, toggleMaximizeWindow: () => {}, closeWindow: () => {},
    } as unknown as CompanionDesktopBridge
  }, GUEST_GUIDE_DISMISSED_KEY)
})

for (const theme of ['dark', 'light'] as const) {
  test(`desktop preferences and title bar remain readable in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize(theme === 'light' ? { width: 1280, height: 800 } : { width: 1440, height: 960 })
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: THEME_KEY, value: theme })
    await page.goto('/control')
    await expect(page.getByRole('heading', { name: '我的桌面工作台' })).toBeVisible()
    await expect(page.locator('.desktop-titlebar')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    const select = page.getByLabel('打开工作台时')
    await pickStudioOptionByValue(select, '/gallery')
    await expect(page.getByRole('status').filter({ hasText: '已保存，下次打开工作台时生效。' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`desktop-${theme}.png`), fullPage: true })
    await page.goto('/')
    await expect(page).toHaveURL(/\/gallery$/)
    await page.goto('/control')
    await expect(select).toContainText('我的作品')
    await pickStudioOptionByValue(select, 'last')
    await page.goto('/video-studio')
    await expect(page.locator('h1')).toBeVisible()
    await page.goto('/')
    await expect(page).toHaveURL(/\/video-studio$/)
    await page.goto('/gallery?project=example')
    await expect(page).toHaveURL(/\/gallery\?project=example$/)
  })
}

test('desktop start preference does not redirect a normal browser', async ({ page }) => {
  await page.addInitScript(key => {
    window.desktopCapabilitiesFixture = undefined
    localStorage.setItem(key, '/gallery')
  }, DESKTOP_START_PAGE_KEY)
  await page.goto('/')
  await expect(page).toHaveURL(/\/$/)
  await expect(page.locator('.desktop-titlebar')).toHaveCount(0)
})

test.beforeEach(async ({ page }) => { await installDesktopHostFixture(page) })

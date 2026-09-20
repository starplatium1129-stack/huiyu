import { test, expect } from '@playwright/test'
import { textContrast } from './helpers/contrast'

for (const theme of ['light', 'dark']) {
  test(`search loads on demand and preserves keyboard and pointer focus ${theme}`, async ({ page }, testInfo) => {
    await page.addInitScript(theme => {
      localStorage.setItem('aics_theme', theme)
      localStorage.setItem('atelier-desktop-appearance-v1', JSON.stringify({ theme, motion: 'reduce' }))
    }, theme)
    const loaded: string[] = []
    page.on('request', request => loaded.push(request.url()))
    await page.goto('/')
    const trigger = page.getByRole('button', { name: '搜索页面、场景与作品', exact: true })
    await expect(trigger).toBeVisible()
    expect(loaded.filter(url => /\/GlobalSearch-[^/]+\.(js|css)/.test(url))).toEqual([])
    expect(loaded.filter(url => /\/fluidGlassRenderer-[^/]+\.js/.test(url))).toEqual([])
    await trigger.focus()
    await page.keyboard.press('Control+k')
    const dialog = page.getByRole('dialog', { name: '全局搜索', exact: true })
    const input = dialog.getByRole('searchbox')
    await expect(dialog).toBeVisible()
    await expect(input).toBeFocused()
    expect(loaded.some(url => /\/GlobalSearch-[^/]+\.js/.test(url))).toBe(true)
    await input.fill('控制面板')
    await expect(dialog.getByRole('option').first()).toContainText('控制面板')
    expect(await dialog.locator('.gs-row span').first().evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
    await page.screenshot({ path: testInfo.outputPath(`search-${theme}.png`) })
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()
    await trigger.click()
    await expect(input).toBeFocused()
    await page.keyboard.press('Control+k')
    await expect(dialog).toBeHidden()
    await page.keyboard.press('/')
    await expect(input).toBeFocused()
    await input.fill('控制面板')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/control$/)
    await expect(dialog).toBeHidden()
  })
}

test('a slow first search can be cancelled before its code arrives', async ({ page }) => {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let requested = false
  await page.route(/\/GlobalSearch-[^/]+\.js$/, async route => {
    requested = true
    await blocked
    await route.continue()
  })
  await page.goto('/')
  const trigger = page.getByRole('button', { name: '搜索页面、场景与作品', exact: true })
  await trigger.focus()
  await page.keyboard.press('Control+k')
  await expect.poll(() => requested).toBe(true)
  await page.keyboard.press('Escape')
  const delivered = page.waitForResponse(/\/GlobalSearch-[^/]+\.js$/)
  release()
  await delivered
  // Give the cancelled import time to execute, so a late focus steal is observable.
  await page.waitForTimeout(200)
  await expect(page.getByRole('dialog', { name: '全局搜索', exact: true })).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(page.getByRole('searchbox', { name: '搜索场景、作品或页面' })).toBeFocused()
})

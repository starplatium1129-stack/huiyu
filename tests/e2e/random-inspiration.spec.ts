import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark']) {
  test(`random artist reroll and undo work through the real ${theme} director controls`, async ({ page }) => {
    await page.addInitScript(value => {
      localStorage.setItem('aics_theme', value)
      Math.random = () => 0
    }, theme)
    // Neutral catalog fixture; no model request, adult content or source writes.
    await page.route('**/data/tags.json*', route => route.fulfill({ json: [
      { id: 'test-park', en: 'park', cn: '公园', cat: 'Scene' },
    ] }))
    await page.goto('/prompt-builder?mode=pro')
    await page.getByRole('button', { name: '专家模式', exact: true }).click()
    await page.getByRole('tab', { name: '画面', exact: true }).click()
    const summary = page.getByTestId('artist-style-picker').locator('.artist-summary-right strong')
    await expect(summary).toHaveText('未启用')
    await page.locator('.random-menu-trigger').click()
    await page.getByRole('dialog', { name: '夏目的调色笔记', exact: true }).getByRole('checkbox').check()
    await page.locator('.random-dice').click()
    await expect(summary).toHaveText('监督')
    await page.evaluate(() => { Math.random = () => 0.4 })
    await page.locator('.random-dice').click()
    await expect(summary).not.toHaveText('监督')
    await expect(summary).not.toHaveText('未启用')
    await page.locator('.random-menu-trigger').click()
    await page.locator('.random-undo').click()
    await expect(summary).toHaveText('监督')
    await page.locator('.random-menu-trigger').click()
    await expect(page.locator('.random-undo')).toBeDisabled()
  })
}

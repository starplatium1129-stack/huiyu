import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark']) {
  test(`random previews invalidate safely and preserve undo in ${theme} mode`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.route('**/data/tags.json*', route => route.fulfill({ json: [
      { id: 'test-park', en: 'park', cn: '公园', cat: 'Scene' },
    ] }))
    await page.goto('/prompt-builder?mode=pro')
    await page.getByRole('button', { name: '专家模式', exact: true }).click()
    await page.getByRole('tab', { name: '画面', exact: true }).click()
    await page.locator('.random-menu-trigger').click()
    const dialog = page.getByRole('dialog', { name: '夏目的调色笔记', exact: true })
    await expect(dialog).toHaveCount(1)
    const seed = dialog.getByRole('textbox', { name: '灵感种子', exact: true })
    const preview = dialog.getByRole('button', { name: '预览 3 组候选', exact: true })
    await seed.fill('41')
    await preview.click()
    await expect(dialog.locator('.random-candidate')).toHaveCount(3)
    await dialog.getByRole('switch', { name: '混入知名画师特调笔触', exact: true }).check()
    await expect(dialog.locator('.random-candidate')).toHaveCount(0)
    await preview.click()
    await seed.fill('-1')
    await preview.click()
    await expect(dialog.locator('.random-candidate')).toHaveCount(0)
    await seed.fill('41')
    await preview.click()
    const apply = dialog.getByRole('button', { name: '应用候选 1', exact: true })
    await apply.click()
    await apply.click()
    await expect(dialog.locator('.random-undo')).toBeEnabled()
    await dialog.locator('.random-undo').click()
    await expect(page.getByTestId('artist-style-picker').locator('.artist-summary-right strong')).toHaveText('未启用')
    await page.locator('.random-menu-trigger').click()
    await expect(dialog).toHaveCount(1)
    await expect(dialog.locator('.random-undo')).toBeDisabled()
    await expect(dialog.locator('.random-candidate')).toHaveCount(0)
  })

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
    const dialog = page.getByRole('dialog', { name: '夏目的调色笔记', exact: true })
    await expect(dialog).toHaveCount(1)
    await dialog.getByRole('switch', { name: '混入知名画师特调笔触', exact: true }).check()
    await page.locator('.random-dice').click()
    await expect(summary).not.toHaveText('未启用')
    const firstArtist = await summary.textContent()
    await page.evaluate(() => { Math.random = () => 0.4 })
    await page.locator('.random-dice').click()
    await expect(summary).not.toHaveText(firstArtist!)
    await expect(summary).not.toHaveText('未启用')
    await page.locator('.random-menu-trigger').click()
    await page.locator('.random-undo').click()
    await expect(summary).toHaveText(firstArtist!)
    await page.locator('.random-menu-trigger').click()
    await expect(dialog).toHaveCount(1)
    await expect(dialog.locator('.random-undo')).toBeDisabled()
  })
}

import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark']) {
  test(`desktop keyboard, singleton help and repeated geometry ${theme}`, async ({ page }) => {
    await page.addInitScript(t => localStorage.setItem('aics_theme', t), theme)
    await page.goto('/scene-explorer')
    await page.locator('.nav-search').focus()
    await page.keyboard.press('F6')
    await expect(page.locator('h1')).toBeFocused()
    await page.keyboard.press('Shift+F6')
    await expect(page.locator('.nav-links > a.active')).toBeFocused()
    let baseline: { width: number; height: number; x: number; y: number } | undefined
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('F1')
      const dialog = page.getByRole('dialog', { name: '键盘快捷键' })
      await expect(dialog).toBeVisible()
      await page.waitForTimeout(650)
      const rect = (await dialog.boundingBox())!
      if (!baseline) baseline = rect
      expect(Math.abs(rect.width - baseline.width)).toBeLessThan(.5)
      expect(Math.abs(rect.y - baseline.y)).toBeLessThan(.5)
      await page.keyboard.press('F6')
      expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true)
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
    }
    await page.goto('/control'); await page.locator('.control-rail').waitFor(); await page.keyboard.press('F1')
    await expect(page.getByRole('dialog', { name: '键盘快捷键' })).toHaveCount(1)
    await expect(page.getByRole('dialog', { name: '键盘快捷键' })).toBeVisible()
  })

  test(`appearance preferences stop active motion and survive reload ${theme}`, async ({ page }) => {
    await page.addInitScript(t => localStorage.setItem('aics_theme', t), theme)
    await page.goto('/scene-explorer')
    await page.locator('.nav-more summary').click()
    await page.getByRole('button', { name: '外观与动态效果', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '外观与动态效果' })
    await dialog.getByRole('combobox', { name: '动态效果', exact: true }).selectOption('reduce')
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'true')
    await dialog.getByRole('checkbox', { name: /降低玻璃效果/ }).check()
    await expect(page.locator('[data-fluid-refracted]')).toHaveCount(0)
    await page.screenshot({ path: `scripts/archive/fluid-complete/verified/${theme}-appearance.png` })
    await page.keyboard.press('Escape'); await expect(dialog).toBeHidden()
    await page.locator('.nav-search').click()
    await expect(page.locator('.global-search')).toHaveCSS('opacity', '1')
    await expect(page.locator('.gs-panel')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'true')
    await expect(page.locator('html')).toHaveAttribute('data-fluid-effects', 'low')
    await page.emulateMedia({ forcedColors: 'active' })
    await page.locator('.nav-search').click()
    await expect(page.locator('.global-search')).toHaveCSS('backdrop-filter', 'none')
    await page.screenshot({ path: `scripts/archive/fluid-complete/verified/${theme}-forced-colors.png` })
    await page.keyboard.press('Escape')
    await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'reduce' })
    await expect(page.locator('html')).not.toHaveCSS('display', 'none')
    await expect(page.locator('.nav')).toBeVisible()
  })

  test(`story drawer retains its content during exit ${theme}`, async ({ page }) => {
    await page.addInitScript(t => localStorage.setItem('aics_theme', t), theme)
    await page.goto('/scene-explorer')
    await page.getByRole('button', { name: '故事', exact: true }).first().click()
    const drawer = page.getByRole('dialog', { name: '场景故事' })
    await expect(drawer).toBeVisible()
    await page.waitForTimeout(650)
    const title = await drawer.locator('h3').textContent()
    await page.screenshot({ path: `scripts/archive/fluid-complete/verified/${theme}-story.png` })
    await page.keyboard.press('Escape')
    await expect(page.locator('.story-card h3')).toHaveText(title!)
    await expect(page.locator('.story-drawer')).toHaveAttribute('inert', '')
    await expect(drawer).toBeHidden()
  })
}

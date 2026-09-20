import { test, expect, type Page } from '@playwright/test'
import { textContrast } from './helpers/contrast'

const key = 'atelier-desktop-appearance-v1'
async function openAppearance(page: Page) {
  await expect(page.locator('.nav')).toBeVisible()
  const menu = page.locator('.nav-menu-toggle')
  if (await menu.isVisible() && await menu.getAttribute('aria-expanded') !== 'true') await menu.click()
  await page.locator('.nav-more > summary').click()
  await page.getByRole('button', { name: '外观与动态效果', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '外观与动态效果' })
  await expect(dialog.getByRole('radio', { name: /轻盈玻璃/ })).toBeVisible()
  await expect(dialog).toHaveCSS('opacity', '1')
  return dialog
}

for (const theme of ['light', 'dark']) {
  test(`glass material opt-in, persistence and resource release ${theme}`, async ({ page, context }, testInfo) => {
    await page.addInitScript(({ key, theme }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ theme, reducedGlass:false }))
      localStorage.setItem('aics_theme', theme)
    }, { key, theme })
    await page.goto('/scene-explorer')
    await expect(page.locator('html')).toHaveAttribute('data-glass-material', 'light')
    await expect(page.locator('.fluid-glass-definitions')).toHaveCount(0)
    await expect(page.locator('.scene-toolbar')).toHaveCSS('backdrop-filter', 'none')
    await page.screenshot({ path:testInfo.outputPath(`lightweight-${theme}.png`) })
    let dialog = await openAppearance(page)
    await expect(dialog.getByRole('radio', { name: /轻盈玻璃/ })).toBeChecked()
    for (const text of await dialog.locator('.glass-choice-body strong, .glass-choice-body small').all()) {
      expect(await text.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
    }
    await dialog.getByRole('radio', { name: /液态玻璃/ }).check()
    await expect(page.locator('html')).toHaveAttribute('data-glass-material', 'liquid')
    await page.screenshot({ path:testInfo.outputPath(`choice-${theme}.png`) })
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(page.locator('.scene-toolbar')).toHaveAttribute('data-fluid-refracted', '')
    await expect(page.locator('.scene-toolbar')).toHaveCSS('backdrop-filter', /url\(/)
    await page.screenshot({ path:testInfo.outputPath(`liquid-${theme}.png`) })
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-glass-material', 'liquid')
    const second = await context.newPage()
    await second.goto('/gallery')
    await expect(second.locator('html')).toHaveAttribute('data-glass-material', 'liquid')
    dialog = await openAppearance(page)
    await dialog.getByRole('radio', { name: /轻盈玻璃/ }).check()
    await expect(page.locator('.fluid-glass-definitions')).toHaveCount(0)
    await expect(page.locator('[data-fluid-refracted]')).toHaveCount(0)
    await expect(second.locator('html')).toHaveAttribute('data-glass-material', 'light')
    await expect(second.locator('.fluid-glass-definitions')).toHaveCount(0)
    await second.close()
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-glass-material', 'light')
  })

  test(`liquid choice respects accessibility and stays usable in a narrow window ${theme}`, async ({ page }, testInfo) => {
    await page.addInitScript(({ key, theme }) => {
      localStorage.setItem(key, JSON.stringify({ theme, glass:'liquid', motion:'reduce' }))
    }, { key, theme })
    await page.setViewportSize({ width:390, height:740 })
    await page.goto('/')
    const dialog = await openAppearance(page)
    await expect(dialog.getByRole('radio', { name:/液态玻璃/ })).toBeChecked()
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'true')
    await page.emulateMedia({ forcedColors:'active' })
    await expect(page.locator('html')).toHaveAttribute('data-glass-material', 'light')
    await expect(page.locator('.fluid-glass-definitions')).toHaveCount(0)
    await expect(dialog.getByRole('radio', { name:/液态玻璃/ })).toBeChecked()
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).glass, key)).toBe('liquid')
    await page.emulateMedia({ forcedColors:'none' })
    await expect(page.locator('html')).toHaveAttribute('data-glass-material', 'liquid')
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await page.screenshot({ path:testInfo.outputPath(`narrow-${theme}.png`) })
  })
}

test('unsupported optics keep the choice operable and use the frosted fallback', async ({ page }) => {
  await page.addInitScript(key => {
    localStorage.setItem(key, JSON.stringify({ glass:'liquid' }))
    const supports = CSS.supports.bind(CSS)
    CSS.supports = ((property: string, value?: string) => value?.includes('url(') ? false : value === undefined ? supports(property) : supports(property, value)) as typeof CSS.supports
  }, key)
  await page.goto('/')
  await expect(page.locator('.fluid-glass-definitions')).toHaveCount(0)
  await expect(page.locator('.nav')).toHaveCSS('backdrop-filter', /blur/)
  const dialog = await openAppearance(page)
  await dialog.getByRole('radio', { name:/轻盈玻璃/ }).check()
  await expect(page.locator('.nav')).toHaveCSS('backdrop-filter', 'none')
})

import { expect, test } from '@playwright/test'
import { textContrast } from './helpers/contrast'

for (const theme of ['light', 'dark']) for (const width of [1440, 900, 800, 390]) {
  test(`more navigation and settings handoff ${theme} ${width}`, async ({ page }, info) => {
    const menuRequests: string[] = []
    page.on('request', request => { if (/AppMoreMenu/.test(request.url())) menuRequests.push(request.url()) })
    await page.setViewportSize({ width, height:844 })
    await page.emulateMedia({ reducedMotion:'reduce' })
    await page.addInitScript(theme => {
      localStorage.setItem('aics_theme', theme)
      localStorage.setItem('atelier-desktop-appearance-v1', JSON.stringify({ theme, reducedGlass:true }))
    }, theme)
    await page.goto('/scene-explorer')
    await expect(page.getByRole('heading', { name:'灵感场景', exact:true })).toBeVisible()
    expect(menuRequests).toEqual([])
    const compact = width <= 900
    const mobile = page.locator('.nav-menu-toggle')
    if (compact) {
      await expect(mobile).toBeVisible()
      expect(await page.locator('.nav').evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(80)
      await mobile.click()
    }
    const trigger = page.getByRole('button', { name:'更多', exact:true })
    await trigger.click()
    const menu = page.getByRole('dialog', { name:'更多页面', exact:true })
    await expect(menu).toBeVisible()
    expect(menuRequests.length).toBeGreaterThan(0)
    await expect(menu.getByRole('link', { name:'我的作品', exact:true })).toBeFocused()
    const box = (await menu.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(width)
    expect(box.y + box.height).toBeLessThanOrEqual(844)
    expect(await menu.getByRole('link', { name:'我的作品', exact:true }).evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
    await page.screenshot({ path:info.outputPath(`more-${theme}-${width}.png`) })
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(trigger).toBeFocused()
    if (compact) await expect(mobile).toHaveAttribute('aria-expanded', 'true')
    if (width === 1440) {
      await trigger.click()
      await expect(menu).toBeVisible()
      await page.keyboard.press('F6')
      await expect(page.locator('main h1')).toBeFocused()
      await expect(menu).toHaveCount(0)
    }
    await trigger.press('Enter')
    await menu.getByRole('link', { name:'我的作品', exact:true }).press('Enter')
    await expect(page).toHaveURL(/\/gallery$/)
    await expect(page.locator('main h1')).toBeFocused()
    await expect(menu).toHaveCount(0)
    if (compact) await mobile.click()
    await trigger.click()
    await menu.getByRole('button', { name:'外观与动态效果', exact:true }).click()
    const appearance = page.locator('.appearance-dialog')
    await expect(appearance).toBeVisible()
    await expect(menu).toHaveCount(0)
    await expect.poll(() => appearance.evaluate(el => el.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(appearance).toBeHidden()
    await expect(compact ? mobile : trigger).toBeFocused()
    if (compact) await mobile.click()
    await trigger.click()
    await menu.getByRole('button', { name:'初次来访 · 使用指南' }).click()
    const guide = page.getByRole('dialog', { name:'访客导览' })
    await expect(guide).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(guide).toBeHidden()
    await expect(compact ? mobile : trigger).toBeFocused()
  })
}

test('more popover keeps its trigger anchor while entering', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto('/scene-explorer')
  const trigger = page.getByRole('button', { name: '更多', exact: true })
  await expect(trigger).toBeVisible()
  const triggerBox = (await trigger.boundingBox())!
  // Extend the enter animation so an accidental positional transform is observable.
  await page.addStyleTag({ content: '.studio-popover[data-state="open"] { animation-duration: 800ms !important; }' })
  await trigger.click()
  const menu = page.getByRole('dialog', { name: '更多页面', exact: true })
  await expect(menu).toBeVisible()
  await expect(menu).toHaveAttribute('data-side', 'bottom')
  const frame = await menu.evaluate(element => ({
    top: element.getBoundingClientRect().top,
    transform: getComputedStyle(element).transform,
  }))
  const triggerAfter = (await trigger.boundingBox())!
  expect(Math.abs(triggerAfter.y - triggerBox.y)).toBeLessThanOrEqual(1)
  expect(frame.transform).toBe('none')
  expect(Math.abs(frame.top - (triggerAfter.y + triggerAfter.height + 10))).toBeLessThanOrEqual(2)
})

test('a failed menu download keeps primary navigation available', async ({ page }) => {
  await page.goto('/scene-explorer')
  await expect(page.locator('main h1')).toBeVisible()
  const module = /\/AppMoreMenu(?:\.vue|-[^/]+\.js)(?:\?|$)/
  await page.route(module, route => route.abort())
  await page.getByRole('button', { name:'更多', exact:true }).click()
  await expect(page.locator('.toast-msg').filter({ hasText:'菜单暂未加载' })).toBeVisible()
  await expect(page.getByRole('button', { name:'更多', exact:true })).toBeEnabled()
  await page.getByRole('navigation', { name:'主导航' }).getByRole('link', { name:'参考画册', exact:true }).click()
  await expect(page).toHaveURL(/\/showcase$/)
  await expect(page.locator('main > .route-view:not([inert]) h1')).toBeVisible()
  await page.unroute(module)
  await page.reload()
  await page.getByRole('button', { name:'更多', exact:true }).click()
  await expect(page.getByRole('dialog', { name:'更多页面' })).toBeVisible()
})

import { expect, test } from '@playwright/test'
import { OFFICE_FIXTURE, OFFICE_ROUTES, prepareOffice, previewRoundTrip, visitOfficeRoute } from './helpers/ui-fluidity-office'

for (const theme of ['dark', 'light']) {
  for (const mode of ['full', 'low', 'reduce'] as const) {
    test(`009 preview keeps focus, scroll and fixed geometry ${theme} ${mode}`, async ({ page }) => {
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
      const writes = await prepareOffice(page, theme, mode)
      await previewRoundTrip(page, false); await previewRoundTrip(page, true)
      const trigger = page.locator('.artwork-button').first(); await trigger.click()
      const viewer = page.locator('.art-viewer.open')
      await expect(viewer).toHaveCSS('transform', 'none')
      const geometry = await viewer.evaluate(el => {
        const rect = el.getBoundingClientRect(), style = getComputedStyle(el)
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight,
          animation: style.animationName, transform: el.style.transform, opacity: el.style.opacity }
      })
      expect(geometry.x).toBe(0); expect(geometry.y).toBe(0)
      expect(Math.abs(geometry.width - geometry.viewportWidth)).toBeLessThanOrEqual(1)
      expect(Math.abs(geometry.height - geometry.viewportHeight)).toBeLessThanOrEqual(1)
      expect(geometry.animation).toBe('none'); expect(geometry.transform).toBe(''); expect(geometry.opacity).toBe('')
      await page.screenshot({ path: test.info().outputPath(`009-preview-${theme}-${mode}.png`) })
      await page.keyboard.press('Escape')
      await expect(page.locator('.art-viewer')).toBeHidden()
      expect(errors).toEqual([]); expect(writes).toEqual([])
    })
    test(`009 immediate close never leaves a ghost surface ${theme} ${mode}`, async ({ page }) => {
      const writes = await prepareOffice(page, theme, mode)
      const trigger = page.locator('.artwork-button').first()
      for (let round = 0; round < 3; round++) {
        await trigger.focus(); await trigger.evaluate(el => (el as HTMLButtonElement).click())
        await page.waitForFunction(() => document.querySelector('.art-viewer')?.classList.contains('open'))
        await page.keyboard.press('Escape')
        await expect(page.locator('.art-viewer')).toBeHidden()
        await expect(trigger).toBeFocused()
        await expect(page.locator('body')).not.toHaveClass(/overlay-open/)
      }
      expect(writes).toEqual([])
    })
  }
  test(`009 cached navigation and query changes never replay first entry ${theme}`, async ({ page }) => {
    await page.addInitScript(() => {
      const animate = Element.prototype.animate
      Element.prototype.animate = function (...args: Parameters<Element['animate']>) {
        if (this.classList.contains('route-view')) this.setAttribute('data-office-entries', String(Number(this.getAttribute('data-office-entries') || 0) + 1))
        return animate.apply(this, args)
      }
    })
    const writes = await prepareOffice(page, theme, 'full')
    for (const path of OFFICE_ROUTES) {
      await visitOfficeRoute(page, path)
      await page.locator('main > .route-view').evaluate((el, path) => {
        el.setAttribute('data-office-cached', path); el.setAttribute('data-office-entries', '0')
      }, path)
    }
    for (const path of OFFICE_ROUTES) {
      await visitOfficeRoute(page, path)
      await expect(page.locator('main > .route-view')).toHaveAttribute('data-office-cached', path)
      await expect(page.locator('main > .route-view')).toHaveAttribute('data-office-entries', '0')
    }
    await visitOfficeRoute(page, '/scene-explorer')
    await page.locator('main > .route-view').evaluate(el => el.setAttribute('data-office-entries', '0'))
    await page.locator('#sceneSearch').fill('F0 固定场景 2')
    await expect(page).toHaveURL(/\?q=/)
    await expect(page.locator('main > .route-view')).toHaveAttribute('data-office-entries', '0')
    expect(writes).toEqual([])
  })
  test(`009 optional route animation failure does not block subsequent navigation ${theme}`, async ({ page }) => {
    await page.addInitScript(() => {
      const animate = Element.prototype.animate
      Element.prototype.animate = function (...args: Parameters<Element['animate']>) {
        if (this.classList.contains('route-view')) throw new Error('009 injected optional WAAPI failure')
        return animate.apply(this, args)
      }
    })
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    const writes = await prepareOffice(page, theme, 'full')
    for (const path of ['/scene-explorer', '/style', '/prompt-builder', '/gallery']) await visitOfficeRoute(page, path)
    expect(errors).toEqual([]); expect(writes).toEqual([])
  })
  test(`009 changing the persisted preference settles the open preview ${theme}`, async ({ page }) => {
    const writes = await prepareOffice(page, theme, 'full')
    await page.locator('.artwork-button').first().evaluate(el => (el as HTMLButtonElement).click())
    await page.waitForFunction(() => document.querySelector('.art-viewer')?.classList.contains('open'))
    await page.evaluate(({ key, theme }) => {
      localStorage.setItem(key, JSON.stringify({ theme, motion: 'reduce', reducedGlass: false }))
      window.dispatchEvent(new StorageEvent('storage', { key }))
    }, { key: OFFICE_FIXTURE.appearanceKey, theme })
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce')
    await expect(page.locator('.art-viewer.open')).toHaveCSS('transform', 'none')
    await page.keyboard.press('Escape'); await expect(page.locator('.art-viewer')).toBeHidden()
    expect(writes).toEqual([])
  })
}

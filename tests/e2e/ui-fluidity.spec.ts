import { expect, test } from '@playwright/test'
import { OFFICE_FIXTURE, OFFICE_ROUTES, prepareOffice, previewRoundTrip, visitOfficeRoute, onArtTextContrast } from './helpers/ui-fluidity-office'

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
      const ratios: number[] = []
      for (const button of await viewer.locator('.viewer-actions .btn-ghost:not(.btn-danger)').all()) {
        ratios.push(await button.evaluate(onArtTextContrast))
      }
      expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5)
      console.log('009-VIEWER-CONTRAST', JSON.stringify({ theme, mode, lowerBounds: ratios }))
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

for (const theme of ['dark', 'light']) {
  test(`009 particles honor app motion and hidden/resume without stale drawing ${theme}`, async ({ page }) => {
    await page.addInitScript(() => {
      const clear = CanvasRenderingContext2D.prototype.clearRect
      CanvasRenderingContext2D.prototype.clearRect = function (...args: Parameters<CanvasRenderingContext2D['clearRect']>) {
        if (this.canvas.closest('.semantic-particle-field')) this.canvas.dataset.officeDraws = String(Number(this.canvas.dataset.officeDraws || 0) + 1)
        return clear.apply(this, args)
      }
    })
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    const writes = await prepareOffice(page, theme, 'full')
    // A tiny neutral cloud, never the operator's models or personal artwork.
    await page.route('**/assets/particles/p_*.json', route => route.fulfill({ json: {
      id: '009-neutral-cloud', aspect: 1, palette: ['#a8abc0'], grid: { w: 8, h: 8, cells: '0'.repeat(64) },
    } }))
    await page.goto('/popular-scenes')
    const field = page.locator('.pop-hero-field')
    await expect(field).toHaveClass(/has-canvas/)
    const canvas = field.locator('canvas')
    const count = async () => Number(await canvas.getAttribute('data-office-draws') || 0)
    await expect.poll(count).toBeGreaterThan(0)
    async function motion(value: string) {
      await page.evaluate(({ key, theme, value }) => {
        localStorage.setItem(key, JSON.stringify({ theme, motion: value, reducedGlass: false }))
        window.dispatchEvent(new StorageEvent('storage', { key }))
      }, { key: OFFICE_FIXTURE.appearanceKey, theme, value })
    }
    await motion('reduce'); await expect(field).toHaveClass(/is-static/)
    const stopped = await count()
    // An observation window proves absence of drawing, not a readiness delay.
    await page.waitForTimeout(120); expect(await count()).toBe(stopped)
    await page.screenshot({ path: test.info().outputPath(`009-particles-${theme}-reduce.png`) })
    await motion('full'); await expect(field).not.toHaveClass(/is-static/)
    await expect.poll(count).toBeGreaterThan(stopped)
    await page.evaluate(async () => {
      const original = Object.getOwnPropertyDescriptor(document, 'hidden')
      try {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
        document.dispatchEvent(new Event('visibilitychange'))
        const canvas = document.querySelector<HTMLCanvasElement>('.pop-hero-field canvas')!
        const before = canvas.dataset.officeDraws
        await new Promise(resolve => setTimeout(resolve, 120))
        if (canvas.dataset.officeDraws !== before) throw new Error('Hidden particles kept drawing')
      } finally {
        if (original) Object.defineProperty(document, 'hidden', original)
        else Reflect.deleteProperty(document, 'hidden')
        document.dispatchEvent(new Event('visibilitychange'))
      }
    })
    const resumed = await count(); await expect.poll(count).toBeGreaterThan(resumed)
    await page.screenshot({ path: test.info().outputPath(`009-particles-${theme}-full.png`) })
    expect(errors).toEqual([]); expect(writes).toEqual([])
  })
}

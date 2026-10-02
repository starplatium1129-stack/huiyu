import { expect, test, type Page } from '@playwright/test'

async function navigate(page: Page, path: string) {
  await page.evaluate(path => {
    const app = document.querySelector('#app') as unknown as { __vue_app__: { config: { globalProperties: { $router: { push: (path: string) => Promise<unknown> } } } } }
    return app.__vue_app__.config.globalProperties.$router.push(path)
  }, path)
}

test('cached gallery retains its DOM and reading position across ordinary and standalone routes', async ({ page }) => {
  await page.goto('/gallery')
  await expect(page.locator('.gallery-page')).toBeVisible()
  await page.locator('.gallery-page').evaluate(element => {
    element.setAttribute('data-cache-probe', 'retained')
    const spacer = document.createElement('div')
    spacer.style.height = '2400px'
    element.append(spacer)
  })
  await page.evaluate(() => scrollTo(0, 480))
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(480)
  for (const destination of ['/style', '/control']) {
    await navigate(page, destination)
    await expect(page).toHaveURL(new RegExp(destination + '$'))
    await navigate(page, '/gallery')
    await expect(page.locator('.gallery-page')).toHaveAttribute('data-cache-probe', 'retained')
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(480)
    await expect(page.locator('.page-main > .route-view')).toHaveCount(1)
    await expect(page.locator('.page-main > .route-view')).not.toHaveAttribute('inert')
  }
})

// Opacity continuity, DOM ownership and cleanup do not vary with theme or viewport.
// Desktop geometry and both theme palettes have their own layout/contrast coverage.
test('peer navigation keeps its displayed frame during interruption', async ({ page }, info) => {
  const theme = 'dark'
  const viewport = { width: 1920, height: 1080 }
  await page.setViewportSize(viewport)
  await page.addInitScript(theme => {
    localStorage.setItem('aics_theme', theme)
    localStorage.setItem('aics_guest_guide_dismissed', '1')
  }, theme)
  await page.goto('/gallery')
  await expect(page.locator('.gallery-page')).toBeVisible()
  await navigate(page, '/style')
  await expect(page.locator('.style-page')).toBeVisible()
  await navigate(page, '/gallery')
  await expect(page.locator('.page-main > .route-view')).toHaveCount(1)
  await expect(page.locator('.gallery-page')).toHaveCSS('opacity', '1')

  const result = await page.evaluate(async () => {
    type RouterHost = { __vue_app__: { config: { globalProperties: { $router: { push(path: string): Promise<unknown> } } } } }
    const router = (document.querySelector('#app') as unknown as RouterHost).__vue_app__.config.globalProperties.$router
    const gallery = document.querySelector<HTMLElement>('.gallery-page')!
    const original = Element.prototype.animate
    const transitions: Array<{ path: string; inert: boolean; frames: Keyframe[] }> = []
    Element.prototype.animate = function (frames, options) {
      if (this.classList.contains('route-view')) transitions.push({ path: (this as HTMLElement).dataset.routePath || '', inert: (this as HTMLElement).inert, frames: frames as Keyframe[] })
      return original.call(this, frames, options)
    }
    try {
      await router.push('/style')
      const style = document.querySelector<HTMLElement>('.style-page')!
      const entrance = style.getAnimations().find(animation => (animation.effect as KeyframeEffect)?.target === style)!
      // Inspect the real browser's rendered intermediate state. Pinning the
      // timeline avoids CPU-load-dependent tests that accidentally finish first.
      entrance.pause(); entrance.currentTime = 60
      const displayedOpacity = Number(getComputedStyle(style).opacity)
      await router.push('/gallery')
      const leave = transitions.find(entry => entry.path === '/style' && entry.inert)!
      const layers = [...document.querySelectorAll<HTMLElement>('.page-main > .route-view')]
      return {
        displayedOpacity, leaveOpacity: Number(leave.frames[0].opacity),
        entryMoves: transitions.filter(entry => !entry.inert).some(entry => entry.frames.some(frame => frame.transform && frame.transform !== 'none')),
        sameGallery: document.querySelector('.gallery-page') === gallery,
        layerCount: layers.length, oldInert: style.inert, newInert: gallery.inert,
      }
    } finally { Element.prototype.animate = original }
  })
  expect(result.displayedOpacity).toBeGreaterThan(0)
  expect(result.displayedOpacity).toBeLessThan(1)
  expect(result.leaveOpacity).toBeCloseTo(result.displayedOpacity, 3)
  expect(result.entryMoves).toBe(false)
  expect(result.sameGallery).toBe(true)
  expect(result.layerCount).toBeLessThanOrEqual(2)
  expect(result.oldInert).toBe(true)
  expect(result.newInert).toBe(false)
  await expect(page.locator('.page-main > .route-view')).toHaveCount(1)
  await expect(page.locator('.gallery-page')).toHaveCSS('opacity', '1')
  await expect(page.locator('.gallery-page')).toHaveCSS('transform', 'none')
  expect(await page.locator('.gallery-page').evaluate(el => el.getAnimations().length)).toBe(0)
  await page.screenshot({ path: info.outputPath(`peer-settled-${theme}-${viewport.width}.png`) })
})

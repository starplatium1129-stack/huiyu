import { expect, test, type Page } from '@playwright/test'

type RecordedMotion = { path: string; frames: Keyframe[] }
async function recordMotion(page: Page) {
  await page.addInitScript(() => {
    const records: RecordedMotion[] = []
    ;(window as unknown as { routeMotions: RecordedMotion[] }).routeMotions = records
    const original = Element.prototype.animate
    Element.prototype.animate = function (frames, options) {
      const path = this.getAttribute('data-route-path')
      if (path) records.push({ path, frames: frames as Keyframe[] })
      return original.call(this, frames, options)
    }
  })
}
async function navigate(page: Page, path: string) {
  await page.evaluate(path => {
    const app = document.querySelector('#app') as unknown as { __vue_app__: { config: { globalProperties: { $router: { push: (path: string) => Promise<unknown> } } } } }
    return app.__vue_app__.config.globalProperties.$router.push(path)
  }, path)
}

for (const theme of ['dark', 'light']) {
  test(`all workspace route shells transition and cached pages retain their DOM ${theme}`, async ({ page }, info) => {
    test.setTimeout(60000)
    await recordMotion(page)
    await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
    await page.goto('/')
    await expect(page.locator('.page-main > .route-view')).toBeVisible()
    for (const path of ['/scene-explorer', '/style', '/lora', '/color-script', '/scenario', '/popular-scenes', '/character', '/scene-manager', '/showcase', '/gallery', '/prompt-builder', '/video-studio', '/missing-page']) {
      await navigate(page, path)
      const incoming = page.locator(`.page-main > .route-view[data-route-path="${path}"]`)
      await expect(incoming).toBeVisible()
      await expect.poll(() => page.evaluate(path => (window as unknown as { routeMotions: RecordedMotion[] }).routeMotions.some(m => m.path === path && m.frames[0].opacity === 0), path)).toBe(true)
      await expect(page.locator('.page-main > .route-view')).toHaveCount(1)
      await expect.poll(() => incoming.evaluate(e => e.getAnimations().filter(a => a.playState === 'running').length)).toBe(0)
      expect(await incoming.evaluate(e => getComputedStyle(e).transform)).toBe('none')
      await expect(incoming).not.toHaveAttribute('inert')
    }
    await navigate(page, '/gallery')
    await page.locator('.gallery-page').evaluate(e => {
      e.setAttribute('data-cache-probe', 'retained')
      const spacer = document.createElement('div'); spacer.style.height = '2400px'; spacer.dataset.testSpacer = 'true'; e.append(spacer)
    })
    await page.evaluate(() => scrollTo(0, 480))
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(480)
    await navigate(page, '/style'); await navigate(page, '/gallery')
    await expect(page.locator('.gallery-page')).toHaveAttribute('data-cache-probe', 'retained')
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(480)
    await expect.poll(() => page.evaluate(() => (window as unknown as { routeMotions: RecordedMotion[] }).routeMotions
      .filter(m => m.path === '/gallery').at(-1)?.frames[0].opacity)).toBe(.88)
    const latest = await page.evaluate(() => (window as unknown as { routeMotions: RecordedMotion[] }).routeMotions.filter(m => m.path === '/gallery').at(-1))
    expect(latest!.frames.every(frame => !('transform' in frame))).toBe(true)
    await expect(page.locator('.page-main > .route-view')).toHaveCount(1)
    await navigate(page, '/control')
    await expect(page.locator('.route-stage > [data-route-path="/control"]')).toBeVisible()
    await navigate(page, '/gallery')
    await expect(page.locator('.gallery-page')).toHaveAttribute('data-cache-probe', 'retained')
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(480)
    await page.locator('[data-test-spacer]').evaluate(e => e.remove())
    await page.evaluate(() => scrollTo(0, 0))
    await page.screenshot({ path: info.outputPath(`cached-return-${theme}.png`) })
  })
}

for (const path of ['/control', '/companion', '/companion-chat', '/chat']) {
  test(`standalone ${path} has an opacity-only entry`, async ({ page }) => {
    await recordMotion(page)
    await page.goto(path)
    await expect.poll(() => page.evaluate(path => (window as unknown as { routeMotions: RecordedMotion[] }).routeMotions.some(m => m.path === path), path)).toBe(true)
    const motion = await page.evaluate(path => (window as unknown as { routeMotions: RecordedMotion[] }).routeMotions.find(m => m.path === path), path)
    expect(motion!.frames).toEqual([{ opacity: 0 }, { opacity: 1 }])
  })
}

test('reduced motion disables ordinary and standalone page entries', async ({ page }) => {
  await recordMotion(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await navigate(page, '/style')
  await expect(page.locator('.style-page')).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { routeMotions: RecordedMotion[] }).routeMotions)).toEqual([])
  await page.goto('/control')
  await expect(page.locator('.route-stage > [data-route-path="/control"]')).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { routeMotions: RecordedMotion[] }).routeMotions)).toEqual([])
})

for (const theme of ['dark', 'light']) test(`scene-card light follows the latest pointer without changing its gradient ${theme}`, async ({ page }, info) => {
  await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
  await page.goto('/scene-explorer')
  const card = page.locator('.sc').first()
  await expect(card).toBeVisible(); await card.hover()
  await expect.poll(() => card.evaluate(e => e.getAnimations().filter(a => a.playState === 'running').length)).toBe(0)
  const result = await card.evaluate(async el => {
    const initial = getComputedStyle(el, '::before').backgroundImage
    const rect = el.getBoundingClientRect()
    let latestX = 0, latestY = 0
    for (const [x, y] of [[35, 40], [115, 92]]) {
      const event = new MouseEvent('mousemove', { bubbles: true, clientX: rect.left + x, clientY: rect.top + y })
      latestX = event.clientX; latestY = event.clientY; el.dispatchEvent(event)
    }
    await new Promise(requestAnimationFrame)
    const style = getComputedStyle(el, '::before'), host = el as HTMLElement
    const current = el.getBoundingClientRect()
    return { initial, gradient: style.backgroundImage, x: parseFloat(host.style.getPropertyValue('--sc-spot-x')), y: parseFloat(host.style.getPropertyValue('--sc-spot-y')),
      expectedX: latestX - current.left, expectedY: latestY - current.top,
      xUnit: host.style.getPropertyValue('--sc-spot-x').endsWith('px'), transform: style.transform }
  })
  expect(result.gradient).toBe(result.initial)
  expect(result.gradient).toContain('radial-gradient')
  expect(result.xUnit).toBe(true)
  expect(result.x).toBeCloseTo(result.expectedX, 1); expect(result.y).toBeCloseTo(result.expectedY, 1)
  expect(result.transform).not.toBe('none')
  await card.screenshot({ path: info.outputPath(`scene-card-${theme}.png`) })
  await page.mouse.move(0, 0)
  await expect.poll(() => card.evaluate(e => (e as HTMLElement).style.getPropertyValue('--sc-spot-o'))).toBe('0')
  await page.emulateMedia({ reducedMotion: 'reduce' }); await card.hover()
  expect(await card.evaluate(e => (e as HTMLElement).style.getPropertyValue('--sc-spot-o'))).toBe('0')
})

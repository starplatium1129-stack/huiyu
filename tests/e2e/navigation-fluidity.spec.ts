import { expect, test } from '@playwright/test'
import { textContrast } from './helpers/contrast'

for (const theme of ['dark', 'light']) {
  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    test(`navigation keeps slow-load feedback ${theme} ${reducedMotion}`, async ({ page }) => {
      await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
      await page.emulateMedia({ reducedMotion })
      await page.goto('/style')
      await expect(page.locator('main h1')).toBeVisible()
      let release!: () => void
      const held = new Promise<void>(resolve => { release = resolve })
      await page.route(/\/_app\/ScenarioView-[^/]+\.js$/, async route => {
        await held
        await route.continue()
      })
      try {
        await page.getByRole('link', { name: '剧本与分幕', exact: true }).click()
        await expect(page.locator('.route-loader')).toHaveClass(/active/)
        await expect(page.getByRole('status', { name: '页面加载状态' })).toContainText('正在打开')
        await expect(page.locator('main')).toHaveAttribute('aria-busy', 'true')
        await expect(page.locator('main h1')).toContainText('画风')
        if (reducedMotion === 'reduce') {
          await expect(page.locator('.route-loader i')).toHaveCSS('animation-name', 'none')
        }
        await page.screenshot({ path: `.review-shots/navigation-pending-${theme}-${reducedMotion}.png` })
      } finally { release() }
      await expect(page).toHaveURL(/scenario$/)
      await expect(page.locator('main h1')).toContainText('剧本')
      await expect(page.locator('.route-loader')).not.toHaveClass(/active/)
      await expect(page.locator('main')).not.toHaveAttribute('aria-busy', 'true')
    })
  }

  test(`cached routes settle without transformed ancestors ${theme}`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.goto('/gallery')
    await expect(page.locator('main h1')).toBeVisible()
    const nav = page.getByRole('navigation', { name: '主导航' })
    await nav.getByRole('link', { name: '绘制', exact: true }).click()
    await expect(page.locator('.gen-bar')).toBeVisible()
    await expect(page.locator('main > .route-view')).toHaveCSS('transform', 'none')
    await nav.locator('summary').click()
    await nav.getByRole('link', { name: '我的作品', exact: true }).click()
    await expect(page.locator('main h1')).toContainText('我的作品')
    await expect(page.locator('main > .route-view')).toHaveCSS('transform', 'none')
    await expect(page.locator('main > .route-view')).not.toHaveAttribute('inert')
    await page.screenshot({ path: `.review-shots/navigation-settled-${theme}.png` })
    expect(errors).toEqual([])
  })
}

for (const theme of ['dark', 'light']) {
  test(`mobile navigation preserves pending destination and contrast ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.goto('/style')
    await expect(page.locator('main h1')).toBeVisible()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    await page.route(/\/_app\/GalleryView-[^/]+\.js$/, async route => { await held; await route.continue() })
    const nav = page.getByRole('navigation', { name: '主导航' })
    try {
      await page.getByRole('button', { name: '打开导航菜单' }).click()
      await nav.locator('summary').click()
      await nav.getByRole('link', { name: '我的作品', exact: true }).click()
      await expect(page.locator('.route-loader')).toHaveClass(/active/)
      await page.getByRole('button', { name: '打开导航菜单' }).click()
      await nav.locator('summary').click()
      const pending = nav.getByRole('link', { name: '我的作品', exact: true })
      await expect(pending).toHaveAttribute('data-pending', 'true')
      await pending.evaluate(async el => {
        for (let parent: Element | null = el; parent; parent = parent.parentElement) {
          await Promise.all(parent.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))
        }
      })
      expect(await pending.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      await page.screenshot({ path: `.review-shots/navigation-mobile-${theme}.png` })
      await page.getByRole('button', { name: '关闭导航菜单' }).click()
    } finally { release() }
    await expect(page).toHaveURL(/gallery$/)
    await expect(page.locator('main > .route-view')).toHaveCSS('transform', 'none')
    await expect(nav.locator('[data-pending="true"]')).toHaveCount(0)
  })

  test(`rapid route reversal preserves the cached workspace ${theme}`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.goto('/prompt-builder')
    await expect(page.locator('.gen-bar')).toBeVisible()
    const nav = page.getByRole('navigation', { name: '主导航' })
    // Warm both pages once, then interrupt entry with actual subsequent navigation.
    await nav.getByRole('link', { name: '灵感', exact: true }).click()
    await expect(page).toHaveURL(/scene-explorer$/)
    for (const path of ['/prompt-builder', '/scene-explorer', '/prompt-builder', '/scene-explorer', '/prompt-builder']) {
      await nav.locator(`a[href="${path}"]`).evaluate((el: HTMLAnchorElement) => el.click())
      await expect(page).toHaveURL(new RegExp(path + '$'))
      await expect(page.locator('main > .route-view')).toHaveCount(1)
      await expect(page.locator('main > .route-view')).not.toHaveAttribute('inert')
      await expect(page.locator('main > .route-view')).toHaveCSS('opacity', '1')
      if (path === '/prompt-builder') {
        // Inspect the entry frame, not just the settled result: no nested text blur/fade.
        const surfaces = await page.locator('.director-workspace, .director-workspace > .col-left, .director-workspace > .col-center, .stage-placeholder:visible').evaluateAll(elements => elements.map(el => {
          const style = getComputedStyle(el)
          return { filter: style.filter, opacity: style.opacity }
        }))
        expect(surfaces.length).toBeGreaterThanOrEqual(3)
        for (const surface of surfaces) expect(surface).toEqual({ filter: 'none', opacity: '1' })
      }
    }
    await expect(page.locator('main > .route-view')).toHaveCSS('transform', 'none')
    await expect(page.locator('.gen-bar')).toBeVisible()
    await page.screenshot({ path: `.review-shots/navigation-workbench-${theme}.png` })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await nav.getByRole('link', { name: '灵感', exact: true }).click()
    await expect(page.locator('main > .route-view')).toHaveCSS('transform', 'none')
  })
}

test('route warming distinguishes pointer transit from keyboard intent and avoids scene data loading', async ({ page }) => {
  // The style page has no background scene lookup; gallery does its own title lookup.
  await page.goto('/style')
  await expect(page.locator('main h1')).toBeVisible()
  const requests: string[] = []
  page.on('request', request => requests.push(request.url()))
  const link = page.getByRole('navigation').getByRole('link', { name: '灵感', exact: true })
  // Both events happen before the dwell timer, without timing-dependent mouse travel.
  await link.evaluate(el => {
    el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    el.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }))
  })
  await page.waitForTimeout(160)
  expect(requests.some(url => /SceneExplorerView-[^/]+\.js/.test(url))).toBe(false)
  const imported = page.waitForResponse(/\/_app\/SceneExplorerView-[^/]+\.js$/)
  await link.focus()
  expect((await imported).ok()).toBe(true)
  expect(requests.filter(url => /\/data\/scenes(?:-[^/?]+)?\.json/.test(url))).toHaveLength(0)
  await expect(page).toHaveURL(/style$/)
})

test('data-saving mode avoids speculative imports but allows normal navigation', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true, effectiveType: '4g' } })
  })
  await page.goto('/gallery')
  await expect(page.locator('main h1')).toBeVisible()
  const requests: string[] = []
  page.on('request', request => requests.push(request.url()))
  const link = page.getByRole('navigation').getByRole('link', { name: '灵感', exact: true })
  await link.hover()
  await link.focus()
  await page.waitForTimeout(160)
  expect(requests.some(url => /SceneExplorerView-[^/]+\.js/.test(url))).toBe(false)
  await link.click()
  await expect(page).toHaveURL(/scene-explorer$/)
  await expect(page.locator('main h1')).toBeVisible()
})

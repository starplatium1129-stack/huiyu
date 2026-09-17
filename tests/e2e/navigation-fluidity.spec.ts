import { expect, test } from '@playwright/test'
import { textContrast } from './helpers/contrast'

test('navigation activation intent is visible before delayed route loading', async ({ page }) => {
  await page.goto('/style')
  await expect(page.locator('main h1')).toBeVisible()
  const link = page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '灵感', exact: true })
  await link.dispatchEvent('pointerdown', { button: 0 })
  await expect(link).toHaveAttribute('data-intent', 'true')
  await expect(page.locator('.route-loader')).not.toHaveClass(/active/)
  await link.click()
  await expect(page).toHaveURL(/scene-explorer$/)
  await expect(link).not.toHaveAttribute('data-intent', 'true')
})

test('failed lazy navigation preserves the current page and offers a retry', async ({ page }) => {
  await page.goto('/style')
  await expect(page.locator('main h1')).toContainText('画风')
  const scenarioChunk = /\/\_app\/ScenarioView-[^/]+\.js$/
  await page.route(scenarioChunk, route => route.abort())
  const more = page.locator('nav.nav .nav-more > summary')
  await more.click()
  await page.getByRole('link', { name: '剧本与分幕', exact: true }).click()
  await expect(page.locator('.route-recovery')).toBeVisible()
  await expect(page.locator('main h1')).toContainText('画风')
  await expect(page.locator('main > .route-view')).not.toHaveAttribute('inert')

  await page.unroute(scenarioChunk)
  await page.locator('.route-recovery a[href="/scenario"]').click()
  await expect(page).toHaveURL(/scenario$/)
  await expect(page.locator('main h1')).toContainText('剧本')
})

test('same-route query updates and browser back preserve the route shell', async ({ page }) => {
  await page.goto('/scene-explorer')
  await expect(page.locator('.scene-toolbar')).toBeVisible()
  await page.locator('#sceneSearch').fill('夜')
  await expect(page).toHaveURL(/scene-explorer\?q=/)
  await expect(page.locator('main > .route-view')).toHaveCount(1)
  await expect(page.locator('main > .route-view')).not.toHaveAttribute('inert')

  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '绘制', exact: true }).click()
  await expect(page).toHaveURL(/prompt-builder$/)
  await page.goBack()
  await expect(page).toHaveURL(/scene-explorer\?q=/)
  await expect(page.locator('.scene-toolbar')).toBeVisible()
  await expect(page.locator('#sceneSearch')).toHaveValue('夜')
})

test('changing motion preference settles an active route transition', async ({ page }) => {
  await page.goto('/style')
  await expect(page.locator('main h1')).toContainText('画风')
  const link = page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '灵感', exact: true })
  const destination = page.waitForURL(/scene-explorer$/)
  await link.evaluate(element => (element as HTMLAnchorElement).click())
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => window.dispatchEvent(new Event('atelier:motion-preference')))
  await destination
  await expect(page.locator('main > .route-view')).toHaveCSS('transform', 'none')
  await expect(page.locator('main > .route-view')).not.toHaveAttribute('inert')
})

test('explicitly revisiting a cached page restores its window scroll position', async ({ page }) => {
  await page.goto('/scene-explorer')
  await expect(page.locator('.scene-grid .stagger-item').first()).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, 640))
  const saved = await page.evaluate(() => window.scrollY)
  expect(saved).toBeGreaterThan(0)

  const nav = page.getByRole('navigation', { name: '主导航' })
  await nav.getByRole('link', { name: '绘制', exact: true }).click()
  await expect(page).toHaveURL(/prompt-builder$/)
  await nav.getByRole('link', { name: '灵感', exact: true }).click()
  await expect(page).toHaveURL(/scene-explorer$/)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(saved - 2)
})

test('keep-alive workbench reuses the same active surface after a route round trip', async ({ page }) => {
  await page.goto('/prompt-builder')
  await expect(page.locator('.pb')).toBeVisible()
  await page.locator('.pb').evaluate(element => element.setAttribute('data-f2-keepalive-probe', 'hit'))

  const nav = page.getByRole('navigation', { name: '主导航' })
  await nav.locator('.nav-more > summary').click()
  await nav.getByRole('link', { name: '我的作品', exact: true }).click()
  await expect(page).toHaveURL(/gallery$/)
  await nav.getByRole('link', { name: '绘制', exact: true }).click()
  await expect(page).toHaveURL(/prompt-builder$/)
  await expect(page.locator('.pb')).toHaveAttribute('data-f2-keepalive-probe', 'hit')
})

test('deactivating the gallery closes its teleported viewer before the next page is usable', async ({ page }) => {
  await page.goto('/gallery')
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('aics_kv_store', 1)
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv', { keyPath: 'key' }) }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const transaction = db.transaction('kv', 'readwrite')
      transaction.objectStore('kv').put({ key: 'aics_pb_history', value: [{ id: 'f2-gallery', sceneTitle: 'F2 夹具作品', character: 'nene', timestamp: Date.now(), image_data: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="purple"/></svg>' }] })
      transaction.oncomplete = () => { db.close(); resolve() }
      transaction.onerror = () => { db.close(); reject(transaction.error) }
    }
  }))
  await page.reload()
  await expect(page.locator('.artwork-button').first()).toBeVisible()
  await page.locator('.artwork-button').first().click()
  await expect(page.locator('.art-viewer.open')).toBeVisible()

  await page.getByRole('dialog', { name: '作品观赏模式' }).getByRole('link', { name: '沿用配方', exact: true }).click()
  await expect(page).toHaveURL(/prompt-builder(?:\?|$)/)
  await expect(page.locator('.art-viewer.open')).toHaveCount(0)
  await expect(page.locator('body')).not.toHaveClass(/overlay-open/)
  await expect(page.getByRole('button', { name: '生成图片', exact: true })).toBeVisible()
})

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

test('committed route intent prewarms bounded core data and showcase thumbnails', async ({ page }) => {
  await page.goto('/style')
  await expect(page.locator('main h1')).toBeVisible()
  const requests: string[] = []
  page.on('request', request => requests.push(request.url()))

  const scene = page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '灵感', exact: true })
  const coreRequest = page.waitForRequest(/\/data\/scenes-core\.json\?v=/)
  await scene.dispatchEvent('pointerdown', { button: 0 })
  await coreRequest
  expect(requests.some(url => /\/data\/scenes-(?:nene|natsume)\.json\?v=/.test(url))).toBe(false)

  const showcase = page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '参考画册', exact: true })
  const manifestRequest = page.waitForRequest(/\/scene-showcase\/manifest\.json/)
  await showcase.dispatchEvent('pointerdown', { button: 0 })
  await manifestRequest
  await page.waitForTimeout(250)
  expect(requests.filter(url => /\/scene-showcase\/thumbs\//.test(url)).length).toBeLessThanOrEqual(4)
})

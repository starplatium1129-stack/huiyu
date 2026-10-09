import { expect, test, type Page } from '@playwright/test'
import { installUiFluidityFixture } from './helpers/ui-fluidity-fixture'

async function openSceneBrowser(page: Page) {
  await page.goto('/scene-explorer')
  const guide = page.getByRole('dialog', { name: '访客导览', exact: true })
  await guide.getByRole('button', { name: '先浏览，稍后配置', exact: true }).click()
  await expect(guide).toBeHidden()
}

async function placeSceneSearch(page: Page) {
  const input = page.locator('#sceneSearch')
  await input.scrollIntoViewIfNeeded()
  await input.evaluate(element => window.scrollTo({ top: Math.max(0, window.scrollY + element.getBoundingClientRect().top - 120), behavior: 'instant' }))
  await expect(input).toBeInViewport({ ratio: 1 })
  return input
}

test('initial lazy route keeps first-paint feedback until content is ready', async ({ page }) => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let requested!: () => void
  const started = new Promise<void>(resolve => { requested = resolve })
  await page.route(/\/(?:_app\/HomeView-[^/]+\.js|src\/views\/HomeView\.vue)$/, async route => {
    requested()
    await held
    await route.continue()
  })
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await started
    await expect.poll(() => page.locator('#app').evaluate(el => getComputedStyle(el, '::before').content)).toContain('HUIYU')
    await expect(page.locator('#app')).not.toHaveAttribute('data-v-app')
  } finally { release() }
  await expect(page.locator('.home-hero')).toBeVisible()
  await expect.poll(() => page.locator('#app').evaluate(el => getComputedStyle(el, '::before').content)).toBe('none')
  await expect(page.locator('#continueCta')).toBeEnabled()
})

test('failed initial lazy route exposes recovery instead of stranding first paint', async ({ page }) => {
  await page.route(/\/(?:_app\/HomeView-[^/]+\.js|src\/views\/HomeView\.vue)$/, route => route.abort())
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const recovery = page.getByRole('alert', { name: '页面加载恢复' })
  await expect(recovery).toBeVisible()
  await expect(recovery.getByRole('link', { name: '重新打开目标页面' })).toHaveAttribute('href', '/')
  await expect.poll(() => page.locator('#app').evaluate(el => getComputedStyle(el, '::before').content)).toBe('none')
})


test('same-route query updates and browser back preserve the route shell', async ({ page }) => {
  await page.goto('/scene-explorer')
  await expect(page.locator('.scene-toolbar')).toBeVisible()
  const backdrop = await page.locator('.route-atmosphere').elementHandle()
  await expect(page.locator('.route-atmosphere')).toHaveCount(1)
  await page.locator('#sceneSearch').fill('夜')
  await expect(page).toHaveURL(/scene-explorer\?q=/)
  await expect(page.locator('main > .route-view')).toHaveCount(1)
  await expect(page.locator('main > .route-view')).not.toHaveAttribute('inert')

  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '绘制', exact: true }).click()
  await expect(page).toHaveURL(/prompt-builder$/)
  expect(await backdrop!.evaluate(element => element.isConnected)).toBe(true)
  await expect(page.locator('.route-atmosphere canvas,.route-cut,.sakura-fall')).toHaveCount(0)
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

test('explicit revisit and browser back restore the scene list window scroll position', async ({ page }) => {
  await openSceneBrowser(page)
  await expect(page.locator('.scene-grid .sc').first()).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, 640))
  const saved = await page.evaluate(() => window.scrollY)
  expect(saved).toBeGreaterThan(0)

  const nav = page.getByRole('navigation', { name: '主导航' })
  await nav.getByRole('link', { name: '绘制', exact: true }).click()
  await expect(page).toHaveURL(/prompt-builder$/)
  await nav.getByRole('link', { name: '灵感', exact: true }).click()
  await expect(page).toHaveURL(/scene-explorer$/)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(saved - 2)
  await nav.getByRole('link', { name: '绘制', exact: true }).click()
  await expect(page).toHaveURL(/prompt-builder$/)
  await page.goBack()
  await expect(page).toHaveURL(/scene-explorer$/)
  await expect(page.locator('.scene-grid .sc').first()).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(saved - 2)
})

test('clearing a scene filter returns to the pre-filter scroll position', async ({ page }) => {
  await openSceneBrowser(page)
  const cards = page.locator('.scene-grid .sc')
  await expect(cards.first()).toBeVisible()
  // Capture after Playwright has made the field visible; locator.fill must not
  // introduce a separate viewport movement between this anchor and the input.
  const input = await placeSceneSearch(page)
  const saved = await page.evaluate(() => window.scrollY)
  expect(saved).toBeGreaterThan(0)

  // 筛到空结果：列表塌缩、文档变矮，浏览器会把滚动位置钳掉
  await input.fill('zzz-没有这种场景-zzz')
  await expect(page.locator('.scene-grid')).toHaveCount(0)
  expect(await page.evaluate(() => window.scrollY)).toBeLessThan(saved)

  // 清空筛选：列表长回来，位置必须回到筛选前，而不是停在被钳掉的地方
  await input.fill('')
  await expect(cards.first()).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(saved - 2)
})

test('a deliberate scroll while filtered wins over the remembered position', async ({ page }) => {
  await openSceneBrowser(page)
  const cards = page.locator('.scene-grid .sc')
  await expect(cards.first()).toBeVisible()
  const input = await placeSceneSearch(page)

  // 筛到仍有结果的查询：列表变短但没塌空
  await input.fill('宁宁')
  await expect(page).toHaveURL(/q=/)
  await expect(page.locator('.scene-grid')).toHaveAttribute('aria-busy', 'false')
  await expect(cards.first()).toBeVisible()
  // Wheel over a card, outside the editable field. Wait for that actual scroll
  // before clearing, rather than racing an asynchronous wheel with scrollTo(0).
  await cards.first().hover()
  const chosen = Math.max(0, await page.evaluate(() => window.scrollY) - 200)
  await page.mouse.wheel(0, -200)
  await expect.poll(async () => Math.abs(await page.evaluate(() => window.scrollY) - chosen)).toBeLessThanOrEqual(2)
  await expect(input).toBeInViewport({ ratio: 1 })

  await input.fill('')
  await expect(page).not.toHaveURL(/q=/)
  await expect(page.locator('.scene-grid')).toHaveAttribute('aria-busy', 'false')
  await expect(cards.first()).toBeVisible()
  await expect.poll(async () => Math.abs(await page.evaluate(() => window.scrollY) - chosen)).toBeLessThanOrEqual(2)
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


for (const theme of ['dark']) {
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
        await page.getByRole('button', { name: '更多', exact: true }).click()
        await page.getByRole('dialog', { name: '更多页面' }).getByRole('link', { name: '剧本', exact: true }).click()
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
      await expect(page.getByRole('heading', { name: '剧本模式', exact: true })).toBeVisible()
      await expect(page.locator('.route-loader')).not.toHaveClass(/active/)
      await expect(page.locator('main')).not.toHaveAttribute('aria-busy', 'true')
    })
  }

}

for (const theme of ['dark']) {
  test(`rapid route reversal preserves the cached workspace ${theme}`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.goto('/prompt-builder')
    await expect(page.locator('.gen-bar')).toBeVisible()
    await page.locator('.pb').evaluate(element => element.setAttribute('data-cache-probe', 'retained'))
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
    await expect(page.locator('.pb')).toHaveAttribute('data-cache-probe', 'retained')
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
  await expect(page.locator('.page-main > .route-view[data-route-path="/scene-explorer"] h1')).toBeVisible()
})

test('committed route intent prewarms bounded core data and leaves showcase loading to the page', async ({ page }) => {
  await installUiFluidityFixture(page, false)
  await page.goto('/style')
  await expect(page.locator('main h1')).toBeVisible()
  const requests: string[] = []
  const prefetchThumbRequests: string[] = []
  page.on('request', request => {
    const url = request.url()
    requests.push(url)
    if (request.resourceType() === 'fetch' && /\/scene-showcase\/thumbs\//.test(url)) prefetchThumbRequests.push(url)
  })

  const scene = page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '灵感', exact: true })
  const coreRequest = page.waitForRequest(/\/data\/scenes-core\.json\?v=/)
  await scene.dispatchEvent('pointerdown', { button: 0 })
  await coreRequest
  expect(requests.some(url => /\/data\/scenes-(?:nene|natsume)\.json\?v=/.test(url))).toBe(false)

  const showcase = page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '参考画册', exact: true })
  await showcase.dispatchEvent('pointerdown', { button: 0 })
  await showcase.click()
  await expect(page).toHaveURL(/showcase$/)
  const sample = page.locator('.showcase-grid .sample-visual').first()
  await expect(sample).toBeVisible()
  await expect(sample).toBeEnabled()
  await expect(page.locator('.showcase-page')).not.toHaveAttribute('inert')
  // The complete activation-to-content window owns exactly one manifest load.
  // Image elements load the visible thumbnails; pointer intent adds no fetch copies.
  expect(requests.filter(url => /\/scene-showcase\/manifest\.json(?:\?|$)/.test(url))).toHaveLength(1)
  expect(prefetchThumbRequests).toHaveLength(0)
})

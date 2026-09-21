import { test, expect } from '@playwright/test'
import MOCK_PORTS from '../../scripts/lib/e2e-ports.js'
test.use({ baseURL: `http://127.0.0.1:${MOCK_PORTS.gateway}` })

for (const theme of ['dark', 'light']) {
  test(`model catalog failure, retry, search and character handoff ${theme}`, async ({ page }, testInfo) => {
    const files: string[] = []
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    page.on('request', req => { const path = new URL(req.url()).pathname; if (path.startsWith('/data/')) files.push(path) })
    let fail = true
    await page.route('**/data/loras.json?*', route => fail ? route.fulfill({ status: 503, json: {} }) : route.continue())
    await page.goto('/lora')
    await expect(page.getByText('模型目录读取失败')).toBeVisible()
    fail = false
    await page.getByRole('button', { name: '重新读取' }).click()
    await expect(page.locator('.lora-card').first()).toBeVisible()
    expect(files.filter(path => /scenes-|scene-blueprints|popular-characters/.test(path))).toEqual([])
    await page.getByRole('searchbox', { name: '搜索模型' }).fill('no-such-model-fixture')
    await expect(page.getByText('没有匹配的模型。')).toBeVisible()
    await page.getByRole('button', { name: '清除搜索' }).click()
    const card = page.locator('.lora-card').filter({ has: page.locator('a[href="/prompt-builder?char=natsume"]') })
    await expect(card).toContainText('本机可用性尚未检测')
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async (value: string) => { document.documentElement.dataset.copiedTrigger = value } } }))
    await card.getByRole('button', { name: '复制触发词' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-copied-trigger', /shiki_natsume/)
    await card.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`lora-${theme}.png`) })
    await card.getByRole('link', { name: '用此角色绘制' }).click()
    await expect(page.locator('article.pb')).toHaveAttribute('data-character', 'natsume')
  })

  test(`missing style references keep palette actions close ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.route('**/scene-showcase/manifest.json', route => route.fulfill({ status: 404, json: {} }))
    await page.goto('/style')
    await expect(page.locator('.style-sample.is-unavailable')).toHaveCount(6)
    const action = page.getByRole('link', { name: /用这个调子绘制/ }).first()
    const box = await action.boundingBox()
    expect(box!.y).toBeLessThan(900)
    await page.screenshot({ path: testInfo.outputPath(`style-${theme}.png`) })
    await action.click()
    await expect(page.locator('article.pb')).toBeVisible()
    await expect(page).toHaveURL(/mood=joy/)
  })

  for (const width of [390, 768, 900, 901, 1280, 1440]) {
    test(`canvas remains single and precedes narrow materials ${theme} ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
      await page.goto('/prompt-builder?char=natsume')
      await expect(page.locator('#drawing-canvas')).toHaveCount(1)
      await expect(page.locator('#drawing-materials .material-drawer')).toBeVisible()
      const canvas = await page.locator('#drawing-canvas').boundingBox()
      const materials = await page.locator('#drawing-materials').boundingBox()
      if (width <= 900) {
        expect(canvas!.y).toBeLessThan(materials!.y)
        expect(canvas!.y).toBeLessThan(450)
        const title = await page.locator('.stage-placeholder-title').boundingBox()
        expect(title!.width).toBeGreaterThan(canvas!.width * .6)
        expect(title!.height).toBeLessThan(100)
        expect(await page.locator('#drawing-canvas').evaluate(el => Boolean(el.compareDocumentPosition(document.querySelector('#drawing-materials')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      await page.screenshot({ path: testInfo.outputPath(`canvas-${theme}-${width}.png`) })
      await page.getByRole('button', { name: '专家模式', exact: true }).click()
      await expect(page.locator('article.pb')).toHaveAttribute('data-character', 'natsume')
      await expect(page.locator('#drawing-canvas')).toHaveCount(1)
    })
  }
}

for (const theme of ['dark', 'light']) test(`missing notebook references stay compact and palette returns keyboard focus ${theme}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
  await page.route('**/scene-showcase/manifest.json', route => route.fulfill({ status: 404, json: {} }))
  await page.goto('/color-script')
  await expect(page.locator('.study-unavailable.is-unconnected')).toHaveCount(2)
  expect((await page.locator('.study-unavailable').first().boundingBox())!.height).toBeLessThan(200)
  await page.screenshot({ path: testInfo.outputPath(`color-compact-${theme}.png`) })
  const mood = page.locator('.mood-card[data-mood="joy"]')
  await mood.focus(); await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '换一个情绪' }).click()
  await expect(mood).toBeFocused()
  await page.goto('/scenario')
  await expect(page.locator('.scenario-cover.is-unconnected')).toHaveCount(3)
  expect((await page.locator('.scenario-cover').first().boundingBox())!.height).toBe(88)
  await page.screenshot({ path: testInfo.outputPath(`scenario-compact-${theme}.png`) })
})

test('remote hostname refuses mature scene browsing even if a local fixture delivers the full catalog', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.hostname !== 'audit-remote.invalid') return route.abort()
    const origin = `http://127.0.0.1:${MOCK_PORTS.gateway}`
    const response = await route.fetch({ url: `${origin}${url.pathname}${url.search}`,
      headers: { ...route.request().headers(), host: `127.0.0.1:${MOCK_PORTS.gateway}`, origin, referer: origin + '/' } })
    await route.fulfill({ response })
  })
  await page.goto('http://audit-remote.invalid/scene-explorer')
  await expect(page.locator('.scene-grid .sc').first()).toBeVisible()
  await page.getByRole('button', { name: /^筛选与收藏/ }).click()
  await expect(page.locator('.mature-hint')).toHaveText('成人场景 · 仅限本机')
  await page.getByRole('combobox', { name: /^分级/ }).selectOption('R18')
  await expect(page.locator('.scene-grid .sc')).toHaveCount(0)
})

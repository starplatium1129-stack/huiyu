import { test, expect } from '@playwright/test'
import MOCK_PORTS from '../../scripts/lib/e2e-ports.js'
import { pickStudioOptionByValue } from './helpers/studioSelect'
test.use({ baseURL: `http://127.0.0.1:${MOCK_PORTS.gateway}` })

for (const theme of ['dark']) {
  test(`model catalog failure, retry, search and character handoff ${theme}`, async ({ page }, info) => {
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
    await expect(page.getByRole('searchbox', { name: '搜索模型' })).toBeFocused()
    await page.getByRole('searchbox', { name: '搜索模型' }).fill('natsume')
    await expect(page.locator('.lora-card')).toHaveCount(2)
    await page.getByRole('button', { name: '清除模型搜索', exact: true }).click()
    await expect(page.getByRole('searchbox', { name: '搜索模型' })).toBeFocused()
    await expect(page.locator('.lora-card')).toHaveCount(4)
    await page.screenshot({ path:info.outputPath(`model-catalog-${theme}.png`) })
    const card = page.locator('.lora-card').filter({ has: page.locator('a[href="/prompt-builder?char=natsume"]') })
    await expect(card).toContainText('本机可用性尚未检测')
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async (value: string) => { document.documentElement.dataset.copiedTrigger = value } } }))
    await card.getByRole('button', { name: '复制触发词' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-copied-trigger', /shiki_natsume/)
    await card.scrollIntoViewIfNeeded()
    await card.getByRole('link', { name: '用此角色绘制' }).click()
    await expect(page.locator('article.pb')).toHaveAttribute('data-character', 'natsume')
  })

  for (const width of [900, 1440]) {
    test(`canvas remains single while switching workspace modes ${theme} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
      await page.goto('/prompt-builder?char=natsume')
      await expect(page.locator('#drawing-canvas')).toHaveCount(1)
      await expect(page.locator('#drawing-materials .material-drawer')).toBeVisible()
      await expect(page.locator('.director-inspector')).toBeVisible()
      const canvas = await page.locator('#drawing-canvas').boundingBox()
      const materials = await page.locator('#drawing-materials').boundingBox()
      if (width <= 900) {
        expect(canvas!.y).toBeLessThan(materials!.y)
        expect(await page.locator('#drawing-canvas').evaluate(el => Boolean(el.compareDocumentPosition(document.querySelector('#drawing-materials')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true)
        expect(canvas!.y).toBeLessThan(450)
        await expect(page.locator('#drawing-canvas').getByRole('button', { name: '挑选场景', exact: true })).toBeInViewport({ ratio: 1 })
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      await expect(page.locator('#drawing-materials')).toBeVisible()
      await expect(page.locator('.director-inspector')).toBeVisible()
      await page.getByRole('button', { name: '专家模式', exact: true }).click()
      await expect(page.locator('article.pb')).toHaveAttribute('data-character', 'natsume')
      await expect(page.locator('#drawing-canvas')).toHaveCount(1)
      await expect(page.locator('#drawing-materials .material-drawer')).toBeVisible()
      await expect(page.locator('.director-inspector')).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    })
  }
}

for (const theme of ['dark']) test(`missing notebook references stay compact and palette returns keyboard focus ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
  await page.route('**/scene-showcase/manifest.json', route => route.fulfill({ status: 404, json: {} }))
  await page.goto('/color-script')
  await page.locator('.color-reading > summary').click()
  await expect(page.locator('.study-unavailable.is-unconnected')).toHaveCount(2)
  expect((await page.locator('.study-unavailable').first().boundingBox())!.height).toBeLessThan(200)
  const mood = page.locator('.mood-card[data-mood="joy"]')
  await mood.focus(); await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '换一个情绪' }).click()
  await expect(mood).toBeFocused()
  await page.goto('/scenario')
  await expect(page.locator('.scenario-cover.is-unconnected')).toHaveCount(3)
  for (const cover of await page.locator('.scenario-cover.is-unconnected').all()) {
    await expect(cover).toBeVisible()
    await expect(cover).toContainText('氛围参考暂未连接')
    expect((await cover.boundingBox())!.height).toBeLessThan(200)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  const books = page.getByRole('group', { name: '故事手帖', exact: true }).getByRole('button')
  await expect(books.first()).toBeVisible()
  for (const book of await books.all()) {
    await book.click({ trial: true })
  }
})

test('remote hostname refuses mature scene browsing even if a local fixture delivers the full catalog', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 })
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
  await page.getByRole('button', { name: /^精细筛选/ }).click()
  await expect(page.locator('.mature-hint')).toHaveText('成人场景 · 仅限本机')
  await pickStudioOptionByValue(page.getByRole('combobox', { name: /^分级/ }), 'R18')
  await expect(page.locator('.scene-grid .sc')).toHaveCount(0)
})

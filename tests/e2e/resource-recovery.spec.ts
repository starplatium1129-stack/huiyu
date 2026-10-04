// Verified resource failures and recovery using local response fixtures.
import { expect, test, type Page, type Route } from '@playwright/test'

const THEMES = ['dark'] as const

type Theme = (typeof THEMES)[number]

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

interface RouteProbe {
  hits: number
  urls: string[]
}

const notFound = (route: Route) => route.fulfill({ status: 404, body: 'glm-next-d fixture: not found' })

const refused = (route: Route) => route.abort('connectionrefused')

const pngFixture = (route: Route) =>
  route.fulfill({ status: 200, contentType: 'image/png', headers: { 'Cache-Control': 'no-store' }, body: TINY_PNG })

async function intercept(page: Page, pattern: string, respond: (route: Route) => void | Promise<void>): Promise<RouteProbe> {
  const probe: RouteProbe = { hits: 0, urls: [] }
  await page.route(pattern, (route) => {
    probe.hits += 1
    probe.urls.push(route.request().url())
    return respond(route)
  })
  return probe
}

async function assertIntercepted(probe: RouteProbe, min = 1): Promise<void> {
  await expect
    .poll(() => probe.hits, {
      timeout: 15_000,
      message: `拦截未命中：期望 ≥${min} 次，实际 ${probe.hits} 次（${probe.urls.join(', ') || '无任何请求'}）`,
    })
    .toBeGreaterThanOrEqual(min)
}

async function openWithTheme(page: Page, path: string, theme: Theme) {
  await page.addInitScript((value) => localStorage.setItem('aics_theme', value), theme)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(path, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('h1').first()).toBeVisible()
}

function failureCase(caseId: string, title: string, body: (page: Page, theme: Theme) => Promise<void>) {
  for (const theme of THEMES) {
    test(`${caseId} ${title} [${theme}]`, async ({ page }) => {
      await body(page, theme)
    })
  }
}


function controlledShowcaseManifest(entryId: string): Record<string, unknown> {
  return {
    entries: [
      {
        id: entryId,
        title: '验收夹具样张',
        story: '',
        category: 'fixture',
        char: 'nene',
        rating: 'All',
        type: 'scene',
        attempt: 1,
      },
    ],
  }
}

const jsonFixture = (body: unknown) => (route: Route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  })

failureCase('F03', '角色列表缩略图 404 首字回退', async (page, theme) => {
  const probe = await intercept(page, '**/assets/characters/thumbs/popular-*.webp*', notFound)
  await openWithTheme(page, '/character?character=nene', theme)
  await page.getByRole('searchbox', { name: '搜索角色或作品' }).fill('芙莉莲')
  const card = page.locator('.directory-item[data-character="frieren"]')
  await card.scrollIntoViewIfNeeded()
  await assertIntercepted(probe)
  await expect(card.locator('.character-portrait')).toHaveAttribute('data-state', 'placeholder')
  await expect(card.locator('.portrait-initial')).toContainText(/\S/)
  // 恢复：解除 404 → 发放有效缩略图 → 重载，状态机回到 image
  await page.unroute('**/assets/characters/thumbs/popular-*.webp*')
  const restored = await intercept(page, '**/assets/characters/thumbs/popular-*.webp*', pngFixture)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('searchbox', { name: '搜索角色或作品' }).fill('芙莉莲')
  await card.scrollIntoViewIfNeeded()
  await assertIntercepted(restored)
  await expect(card.locator('.character-portrait')).toHaveAttribute('data-state', 'image')
  await expect(card.locator('img')).toHaveJSProperty('complete', true)
  await expect(card.locator('img')).not.toHaveJSProperty('naturalWidth', 0)
})

failureCase('F05', '场景卡片缩略图 404 提示可用', async (page, theme) => {
  const probe = await intercept(page, '**/scene-showcase/thumbs/*.jpg*', notFound)
  await openWithTheme(page, '/scene-explorer', theme)
  await assertIntercepted(probe)
  const card = page.locator('.sc').filter({ has: page.locator('img.sc-thumb-missing') }).first()
  await expect(card.locator('img.sc-thumb-missing')).toBeHidden()
  await expect(card.locator('.sc-preview-unavailable')).toHaveText('样张暂缺 · 场景可用')
  await expect(card).toBeVisible()
  await expect(card.locator('.sc-title')).toContainText(/\S/)
  // 恢复：解除 404 → 发放有效缩略图 → 重载，失败标记清零、缩略图就绪
  await page.unroute('**/scene-showcase/thumbs/*.jpg*')
  await intercept(page, '**/scene-showcase/thumbs/*.jpg*', pngFixture)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('img.sc-thumb.sc-thumb-missing')).toHaveCount(0)
  await expect(page.locator('img.sc-thumb.sc-thumb-ready').first()).toBeVisible({ timeout: 15_000 })
})

failureCase('F09', '画册灯箱 404 可关闭可恢复', async (page, theme) => {
  const ENTRY_ID = 'f09fixture001'
  await page.route('**/scene-showcase/manifest.json', jsonFixture(controlledShowcaseManifest(ENTRY_ID)))
  const thumbProbe = await intercept(page, '**/scene-showcase/thumbs/*.jpg*', pngFixture)
  const imagePattern = '**/scene-showcase/images/*.jpg*'
  const imageProbe = await intercept(page, imagePattern, notFound)
  await openWithTheme(page, '/showcase', theme)
  await expect(page.locator('.sample-visual').first()).toBeVisible()
  await assertIntercepted(thumbProbe) // 卡片缩略图请求已放行
  await expect(page.locator('img.sample-image.sample-image-ready').first()).toBeVisible()
  await page.locator('.sample-visual').first().click()
  await expect(page.getByRole('status').filter({ hasText: '高清图暂时无法读取，当前显示缩略图' })).toBeVisible()
  const displayed = page.locator('.showcase-viewer .zoomable-img').first()
  await expect(displayed).toBeVisible()
  await expect(displayed).toHaveAttribute('src', new RegExp(`/thumbs/${ENTRY_ID}\\.jpg`))
  await expect(displayed).toHaveJSProperty('naturalWidth', 1)
  await assertIntercepted(imageProbe) // 大图请求确实被 404
  await page.locator('.viewer-close').click()
  await expect(page.locator('.showcase-viewer')).toBeHidden()
  // 恢复：大图改为放行 → 重开灯箱 → 图片可读（in-place）
  await page.unroute(imagePattern)
  const restored = await intercept(page, imagePattern, pngFixture)
  await page.locator('.sample-visual').first().click()
  await assertIntercepted(restored)
  await expect(displayed).toBeVisible()
  await expect(displayed).toHaveAttribute('src', new RegExp(`/images/${ENTRY_ID}\\.jpg`))
  await expect(displayed).toHaveJSProperty('naturalWidth', 1)
  await expect(page.getByRole('status').filter({ hasText: '高清图暂时无法读取，当前显示缩略图' })).toHaveCount(0)
  await expect(page.locator('.viewer-image-fallback')).toHaveCount(0)
})

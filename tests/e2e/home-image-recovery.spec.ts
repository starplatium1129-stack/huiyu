// Home hero and popular-strip image failure fallback and recovery (N1).
// Follows the verified awaited-route / request-hit / reload-recovery style of resource-recovery.spec.ts.
import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test'

const THEMES = ['dark', 'light'] as const

type Theme = (typeof THEMES)[number]

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

interface RouteProbe {
  hits: number
  urls: string[]
}

const notFound = (route: Route) => route.fulfill({ status: 404, body: 'glm-home-recovery fixture: not found' })

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

async function shot(page: Page, testInfo: TestInfo, caseId: string, theme: Theme) {
  await page.screenshot({ path: testInfo.outputPath(`${caseId}-${theme}.png`) })
}

function failureCase(caseId: string, title: string, body: (page: Page, theme: Theme, testInfo: TestInfo) => Promise<void>) {
  for (const theme of THEMES) {
    test(`${caseId} ${title} [${theme}]`, async ({ page }, testInfo) => {
      await body(page, theme, testInfo)
      await shot(page, testInfo, caseId, theme)
    })
  }
}

failureCase('H1', '英雄图 404 占位可读并恢复', async (page, theme, testInfo) => {
  const neneProbe = await intercept(page, '**/assets/characters/nene-home-cg-1024.webp', notFound)
  const natsumeProbe = await intercept(page, '**/assets/characters/natsume-home-cg-1024.webp', notFound)
  await openWithTheme(page, '/', theme)
  await assertIntercepted(neneProbe)
  await assertIntercepted(natsumeProbe)
  // 失败态：两张英雄图都撤下，当前角色占位可见，文案与行动按钮保持可读
  await expect(page.locator('.hero-orbit .hero-character')).toHaveCount(0)
  await expect(page.locator('.hero-fallback.nene')).toBeVisible()
  await expect(page.locator('.hero-fallback.nene .hero-fallback-text')).toHaveText('主视觉暂未加载')
  await expect(page.locator('.orbit-label span')).toContainText('AYACHI NENE')
  await expect(page.locator('.orbit-label strong')).toContainText(/\S/)
  await expect(page.locator('.hero-title')).toContainText('画进你的故事')
  await expect(page.locator('#continueCta')).toBeVisible()
  await expect(page.locator('.hero-orbit')).toBeVisible()
  await shot(page, testInfo, 'H1-failure', theme)
  // 恢复：解除 404 → 发放有效图 → 重载，图片真实解码且占位清零
  await page.unroute('**/assets/characters/nene-home-cg-1024.webp')
  await page.unroute('**/assets/characters/natsume-home-cg-1024.webp')
  const restored = await intercept(page, '**/assets/characters/nene-home-cg-1024.webp', pngFixture)
  await intercept(page, '**/assets/characters/natsume-home-cg-1024.webp', pngFixture)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await assertIntercepted(restored)
  await expect(page.locator('.hero-character.nene')).not.toHaveJSProperty('naturalWidth', 0)
  await expect(page.locator('.hero-character.nene')).toHaveJSProperty('complete', true)
  await expect(page.locator('.hero-fallback')).toHaveCount(0)
})

failureCase('H2', '英雄图失败按角色隔离且切换重试有界', async (page, theme) => {
  const neneProbe = await intercept(page, '**/assets/characters/nene-home-cg-1024.webp', notFound)
  await intercept(page, '**/assets/characters/natsume-home-cg-1024.webp', pngFixture)
  await openWithTheme(page, '/', theme)
  await assertIntercepted(neneProbe)
  // 宁宁失败出现占位；夏目图不受牵连，仍完成解码
  await expect(page.locator('.hero-character.nene')).toHaveCount(0)
  await expect(page.locator('.hero-fallback.nene')).toBeVisible()
  await expect(page.locator('.hero-character.natsume')).toHaveJSProperty('naturalWidth', 1)
  // 切到夏目：视觉与文案跟随夏目，无宁宁残影
  await page.getByRole('button', { name: '四季夏目' }).click()
  await expect(page.locator('.hero-character.natsume')).toHaveClass(/is-current/)
  await expect(page.locator('.orbit-label span')).toContainText('SHIKI NATSUME')
  // 切回宁宁：失败角色重试一次（请求数 +1，非递归），仍失败则占位回归
  const hitsBefore = neneProbe.hits
  await page.getByRole('button', { name: '绫地宁宁' }).click()
  await assertIntercepted(neneProbe, hitsBefore + 1)
  await expect(page.locator('.hero-character.nene')).toHaveCount(0)
  await expect(page.locator('.hero-fallback.nene')).toBeVisible()
  await expect(neneProbe.hits).toBe(hitsBefore + 1)
  await expect(page.locator('.hero-character.natsume')).toHaveJSProperty('naturalWidth', 1)
})

failureCase('H3', '热门横条缩略图 404 占位并恢复', async (page, theme, testInfo) => {
  const probe = await intercept(page, '**/assets/characters/thumbs/popular-*.webp*', notFound)
  await openWithTheme(page, '/', theme)
  const strip = page.locator('.pop-strip')
  // 横条在首屏折叠线以下，懒加载缩略图需滚动入视口才会发起请求
  await strip.scrollIntoViewIfNeeded()
  await assertIntercepted(probe)
  await expect(strip).toBeVisible()
  // 失败卡显示占位而非裂图；姓名、作品标签与卡片入口保持可读
  await expect(strip.locator('.pop-card-mini .pop-portrait-fallback').first()).toBeVisible()
  await expect(strip.locator('.pop-cap-name').first()).toContainText(/\S/)
  await expect(strip.locator('.pop-cap-franchise').first()).toContainText(/\S/)
  // 每张卡要么有图要么有占位，不允许空卡
  await expect(strip.locator('.pop-card-mini').filter({ hasNot: page.locator('img, .pop-portrait-fallback') })).toHaveCount(0)
  await shot(page, testInfo, 'H3-failure', theme)
  // 恢复：解除 404 → 发放有效缩略图 → 重载，占位清零、缩略图完成解码
  await page.unroute('**/assets/characters/thumbs/popular-*.webp*')
  const restored = await intercept(page, '**/assets/characters/thumbs/popular-*.webp*', pngFixture)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await strip.scrollIntoViewIfNeeded()
  await assertIntercepted(restored)
  await expect(strip.locator('.pop-portrait-fallback')).toHaveCount(0)
  const imgs = strip.locator('.pop-card-mini img')
  const imgCount = await imgs.count()
  for (let i = 0; i < imgCount; i += 1) {
    await expect(imgs.nth(i)).toHaveJSProperty('naturalWidth', 1)
  }
})

failureCase('H4', '单卡失败不拖垮其他卡', async (page, theme) => {
  // 先注册放行全量，再注册单卡 404：后注册者优先生效，只打掉 raiden_shogun 一张
  const okProbe = await intercept(page, '**/assets/characters/thumbs/popular-*.webp*', pngFixture)
  const badProbe = await intercept(page, '**/assets/characters/thumbs/popular-raiden_shogun.webp*', notFound)
  await openWithTheme(page, '/', theme)
  const strip = page.locator('.pop-strip')
  // 同 H3：懒加载缩略图需滚动入视口才会发起请求
  await strip.scrollIntoViewIfNeeded()
  await assertIntercepted(badProbe)
  await assertIntercepted(okProbe, 2)
  // 恰好一张占位，其余卡都是完成解码的图片
  await expect(strip.locator('.pop-card-mini .pop-portrait-fallback')).toHaveCount(1)
  const failedCard = strip.locator('.pop-card-mini').filter({ has: page.locator('.pop-portrait-fallback') })
  await expect(failedCard.locator('.pop-cap-name')).toContainText(/\S/)
  const imgs = strip.locator('.pop-card-mini img')
  const imgCount = await imgs.count()
  expect(imgCount).toBeGreaterThanOrEqual(2)
  for (let i = 0; i < imgCount; i += 1) {
    await expect(imgs.nth(i)).toHaveJSProperty('naturalWidth', 1)
  }
})

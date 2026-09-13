// N2 角色详情立绘缺失状态：主图失败 → 缩略图回退 → 明确缺失状态与恢复。
// 断言同一角色的实际图片解码与可理解状态文字，不只检查 img 存在；
// 拦截计数用于证明"每个来源最多尝试一次、禁止 fallback 循环"。
// 目录卡片与详情回退共用同一缩略图 URL，计数断言一律用"状态稳定后不再增长"的
// 差值法（参考 RD 对 F8 并发缩略图计数的教训），不用绝对次数。
// 参考 tests/e2e/resource-recovery.spec.ts 的 awaited route / 请求命中 /
// 同目标解码 / 失败截图方式；共享工作区不启动浏览器服务，浏览器执行由主任务统一进行。
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

const notFound = (route: Route) => route.fulfill({ status: 404, body: 'glm-character-recovery fixture: not found' })

const pngFixture = (route: Route) =>
  route.fulfill({ status: 200, contentType: 'image/png', headers: { 'Cache-Control': 'no-store' }, body: TINY_PNG })

const jsonFixture = (body: unknown) => (route: Route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  })

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

function themeCase(caseId: string, title: string, body: (page: Page, theme: Theme) => Promise<void>) {
  for (const theme of THEMES) {
    test(`${caseId} ${title} [${theme}]`, async ({ page }, testInfo) => {
      await body(page, theme)
      await shot(page, testInfo, caseId, theme)
    })
  }
}

// 受控角色档案：主图 / 缩略图 URL 全部由夹具指定，配合拦截精确制造故障。
// fixture-c 为 heroine 类型：目录与详情共用同一张主图、没有已登记缩略图。
const MAIN_A = (version: number) => `/assets/characters/fixture-portrait-a.png?v=${version}`
const THUMB_A = '/assets/characters/thumbs/popular-fixture-a.webp'
const MAIN_B = '/assets/characters/fixture-portrait-b.png?v=1'
const HEROINE_MAIN = '/assets/characters/fixture-portrait-c.webp'
const HEROINE_THUMB_MARKER = 'popular-fixture-c'

function fixtureCharacter(id: string, name: string, type: string, image: string) {
  return {
    id, name, type, source: '验收夹具', alias: [], voice: '', tags: ['夹具'],
    bg_story: '', personality: [], likes: [],
    portrait: { image, alt: `${name}立绘` },
  }
}

function fixtureCharacters(mainVersion: number) {
  return [
    fixtureCharacter('fixture-a', '夹具甲', 'popular', MAIN_A(mainVersion)),
    fixtureCharacter('fixture-b', '夹具乙', 'popular', MAIN_B),
    fixtureCharacter('fixture-c', '夹具丙', 'heroine', HEROINE_MAIN),
  ]
}

const DATA_PATTERN = '**/data/characters.json*'

/** 等目录卡片的并发缩略图请求落定后取基线，再等一段时间断言计数不再增长。 */
async function assertProbeStable(page: Page, probe: RouteProbe): Promise<void> {
  await page.waitForTimeout(1000)
  const baseline = probe.hits
  await page.waitForTimeout(1500)
  expect(probe.hits).toBe(baseline)
}

themeCase('CR1', '详情主图失败回退缩略图并真实解码', async (page, theme) => {
  await page.route(DATA_PATTERN, jsonFixture(fixtureCharacters(1)))
  const mainProbe = await intercept(page, '**/assets/characters/fixture-portrait-a.png*', notFound)
  const thumbProbe = await intercept(page, '**/assets/characters/thumbs/popular-fixture-a.webp*', pngFixture)
  await openWithTheme(page, '/character?character=fixture-a', theme)
  await assertIntercepted(mainProbe) // 主图请求确实发出并被 404
  await assertIntercepted(thumbProbe) // 回退链尝试了该角色已登记的缩略图
  const portrait = page.locator('.portrait[data-portrait-state]')
  await expect(portrait).toHaveAttribute('data-portrait-state', 'fallback')
  const img = portrait.locator('img.portrait-image')
  await expect(img).toHaveAttribute('src', THUMB_A)
  await expect(img).toHaveJSProperty('complete', true)
  await expect(img).not.toHaveJSProperty('naturalWidth', 0)
  // 回退图不冒充原图：有可读的回退说明；详情布局、角色名与来源仍可用
  await expect(page.locator('.portrait-fallback-note')).toContainText('原图无法读取')
  await expect(page.locator('.portrait-missing')).toHaveCount(0)
  await expect(page.locator('.character-name')).toHaveText('夹具甲')
  await expect(portrait.locator('.portrait-source')).not.toBeEmpty()
  await expect(portrait.locator('.portrait-badge')).toContainText(/\S/)
})

themeCase('CR2', '主图与缩略图均失败显示缺失状态且不循环', async (page, theme) => {
  await page.route(DATA_PATTERN, jsonFixture(fixtureCharacters(1)))
  const mainProbe = await intercept(page, '**/assets/characters/fixture-portrait-a.png*', notFound)
  const thumbProbe = await intercept(page, '**/assets/characters/thumbs/popular-fixture-a.webp*', notFound)
  await openWithTheme(page, '/character?character=fixture-a', theme)
  await assertIntercepted(mainProbe)
  await assertIntercepted(thumbProbe)
  const portrait = page.locator('.portrait[data-portrait-state="missing"]')
  await expect(portrait).toBeVisible()
  await expect(portrait.locator('.portrait-missing-title')).toHaveText('立绘缺失')
  await expect(portrait.locator('.portrait-missing-text')).toContainText('原图与缩略图均无法读取')
  await expect(portrait.locator('img')).toHaveCount(0) // 不显示裸裂图
  await expect(page.locator('.character-name')).toHaveText('夹具甲')
  await expect(portrait.locator('.portrait-source')).not.toBeEmpty()
  await assertProbeStable(page, mainProbe) // 每个来源最多尝试一次，状态稳定后计数不再增长
  await assertProbeStable(page, thumbProbe)
})

themeCase('CR3', '切角色不串图且切回有界重试', async (page, theme) => {
  await page.route(DATA_PATTERN, jsonFixture(fixtureCharacters(1)))
  const mainAProbe = await intercept(page, '**/assets/characters/fixture-portrait-a.png*', notFound)
  const thumbAProbe = await intercept(page, '**/assets/characters/thumbs/popular-fixture-a.webp*', notFound)
  const mainBProbe = await intercept(page, '**/assets/characters/fixture-portrait-b.png*', pngFixture)
  await openWithTheme(page, '/character?character=fixture-a', theme)
  await assertIntercepted(mainAProbe)
  await assertIntercepted(thumbAProbe)
  await expect(page.locator('.portrait[data-portrait-state="missing"]')).toBeVisible()
  // 切到乙：乙的主图正常加载解码，甲的缺失状态不外溢
  await page.locator('.directory-item[data-character="fixture-b"]').click()
  await assertIntercepted(mainBProbe)
  const portraitB = page.locator('.portrait[data-portrait-state="main"]')
  await expect(portraitB).toBeVisible()
  await expect(portraitB.locator('img.portrait-image')).toHaveAttribute('src', MAIN_B)
  await expect(portraitB.locator('img')).toHaveJSProperty('complete', true)
  await expect(portraitB.locator('img')).not.toHaveJSProperty('naturalWidth', 0)
  await expect(page.locator('.character-name')).toHaveText('夹具乙')
  await expect(page.locator('.portrait-missing')).toHaveCount(0)
  // 切回甲开始新尝试周期，仍保持有界失败且不串乙的图
  const previousMainHits = mainAProbe.hits
  await page.locator('.directory-item[data-character="fixture-a"]').click()
  await expect(page.locator('.portrait[data-portrait-state="missing"]')).toBeVisible()
  await expect(page.locator('.character-name')).toHaveText('夹具甲')
  await expect(page.locator('.portrait img')).toHaveCount(0)
  expect(mainBProbe.hits).toBe(1) // 甲的详情从未请求乙的主图
  await expect.poll(() => mainAProbe.hits).toBeGreaterThan(previousMainHits)
  await assertProbeStable(page, mainAProbe)
  await assertProbeStable(page, thumbAProbe)
})

themeCase('CR4', '页面重载后使用新版本主图恢复', async (page, theme) => {
  await page.route(DATA_PATTERN, jsonFixture(fixtureCharacters(1)))
  const staleProbe = await intercept(page, '**/assets/characters/fixture-portrait-a.png*', notFound)
  await intercept(page, '**/assets/characters/thumbs/popular-fixture-a.webp*', notFound)
  await openWithTheme(page, '/character?character=fixture-a', theme)
  await assertIntercepted(staleProbe)
  await expect(page.locator('.portrait[data-portrait-state="missing"]')).toBeVisible()
  // 数据中主图换成 v=2 且图源恢复：新 src 不被旧失败拦截，主图直接重新加载
  await page.unroute('**/assets/characters/fixture-portrait-a.png*')
  await page.unroute(DATA_PATTERN)
  const freshProbe = await intercept(page, '**/assets/characters/fixture-portrait-a.png*', pngFixture)
  await page.route(DATA_PATTERN, jsonFixture(fixtureCharacters(2)))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('.portrait[data-portrait-state="main"]')).toBeVisible()
  await assertIntercepted(freshProbe)
  const img = page.locator('.portrait img.portrait-image')
  await expect(img).toHaveAttribute('src', MAIN_A(2))
  await expect(img).toHaveJSProperty('complete', true)
  await expect(img).not.toHaveJSProperty('naturalWidth', 0)
  await expect(page.locator('.portrait-missing')).toHaveCount(0)
  await expect(page.locator('.portrait-fallback-note')).toHaveCount(0)
})

themeCase('CR5', '无缩略图角色直接缺失且不虚构图源', async (page, theme) => {
  await page.route(DATA_PATTERN, jsonFixture(fixtureCharacters(1)))
  // 宽口径探针记录 /assets/characters/ 下的一切请求：夹具丙的主图 404，
  // 其余（目录缩略图等）放行，用于断言没有为丙虚构任何缩略图 URL。
  const probe = await intercept(page, '**/assets/characters/**', (route) => {
    if (route.request().url().includes('fixture-portrait-c')) return notFound(route)
    return pngFixture(route)
  })
  await openWithTheme(page, '/character?character=fixture-c', theme)
  const portrait = page.locator('.portrait[data-portrait-state="missing"]')
  await expect(portrait).toBeVisible()
  await expect(portrait.locator('.portrait-missing-title')).toHaveText('立绘缺失')
  await expect(portrait.locator('.portrait-missing-text')).toContainText('没有已登记的缩略图')
  await expect(page.locator('.character-name')).toHaveText('夹具丙')
  await expect(portrait.locator('img')).toHaveCount(0)
  const mainUrls = () => probe.urls.filter((url) => url.includes('fixture-portrait-c'))
  await expect.poll(() => mainUrls().length, { timeout: 15_000, message: `主图请求未命中：${probe.urls.join(', ')}` }).toBeGreaterThanOrEqual(1)
  expect(probe.urls.some((url) => url.includes(HEROINE_THUMB_MARKER))).toBe(false) // 不虚构缩略图/外部 URL
  await assertProbeStable(page, probe)
})

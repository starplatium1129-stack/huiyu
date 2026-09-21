// Scene explorer companion portraits and 404-page chibi image failure fallback (N3).
// Follows the verified awaited-route / request-hit / reload-recovery style of resource-recovery.spec.ts.
import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test'
import { textContrast } from './helpers/contrast'

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

const notFound = (route: Route) => route.fulfill({ status: 404, body: 'glm-illustration-recovery fixture: not found' })

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

failureCase('S1', '场景手帖双图 404 占位可读并恢复', async (page, theme, testInfo) => {
  const neneProbe = await intercept(page, '**/assets/characters/nene-home-cg-1024.webp', notFound)
  const natsumeProbe = await intercept(page, '**/assets/characters/natsume-home-cg-1024.webp', notFound)
  await openWithTheme(page, '/scene-explorer', theme)
  await assertIntercepted(neneProbe)
  await assertIntercepted(natsumeProbe)
  const portrait = page.locator('.scene-atlas-portrait')
  // 失败态：两张陪伴图都撤下，两位角色各有对应占位，无裸裂图
  await expect(portrait.locator('img')).toHaveCount(0)
  await expect(portrait.locator('.companion-fallback.nene')).toHaveClass(/current/)
  await expect(portrait.locator('.companion-fallback.nene .companion-fallback-text')).toHaveText('绫地宁宁的主视觉暂未加载')
  await expect(portrait.locator('.companion-fallback.natsume .companion-fallback-text')).toHaveText('四季夏目的主视觉暂未加载')
  // 台词、标题、陪伴切换与场景入口保持可用
  await expect(portrait.locator('figcaption')).toHaveText('「想和你一起，留住这一刻。」')
  await expect(page.locator('#sceneAtlasTitle')).toHaveText('灵感场景')
  await expect(page.locator('.companion-pill.nene')).toBeVisible()
  await expect(page.locator('.companion-pill.natsume')).toBeVisible()
  await expect(page.locator('.mood-rail').first()).toBeVisible()
  await shot(page, testInfo, 'S1-failure', theme)
  // 恢复：解除 404 → 发放有效图 → 重载，双图真实解码且占位清零
  await page.unroute('**/assets/characters/nene-home-cg-1024.webp')
  await page.unroute('**/assets/characters/natsume-home-cg-1024.webp')
  const restoredNene = await intercept(page, '**/assets/characters/nene-home-cg-1024.webp', pngFixture)
  const restoredNatsume = await intercept(page, '**/assets/characters/natsume-home-cg-1024.webp', pngFixture)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await assertIntercepted(restoredNene)
  await assertIntercepted(restoredNatsume)
  await expect(portrait.locator('img.nene')).toHaveJSProperty('complete', true)
  await expect(portrait.locator('img.nene')).not.toHaveJSProperty('naturalWidth', 0)
  await expect(portrait.locator('img.natsume')).not.toHaveJSProperty('naturalWidth', 0)
  await expect(portrait.locator('.companion-fallback')).toHaveCount(0)
  await expect(portrait.locator('figcaption')).toHaveText('「想和你一起，留住这一刻。」')
})

failureCase('S2', '场景手帖按角色隔离且切换重试有界', async (page, theme) => {
  const neneProbe = await intercept(page, '**/assets/characters/nene-home-cg-1024.webp', notFound)
  await intercept(page, '**/assets/characters/natsume-home-cg-1024.webp', pngFixture)
  await openWithTheme(page, '/scene-explorer', theme)
  await assertIntercepted(neneProbe)
  const portrait = page.locator('.scene-atlas-portrait')
  // 宁宁失败出现对应占位；夏目图不受牵连，仍完成解码
  await expect(portrait.locator('img.nene')).toHaveCount(0)
  await expect(portrait.locator('.companion-fallback.nene')).toHaveClass(/current/)
  await expect(portrait.locator('img.natsume')).toHaveJSProperty('naturalWidth', 1)
  await expect(portrait.locator('figcaption')).toHaveText('「想和你一起，留住这一刻。」')
  // 切到夏目：台词跟随夏目，宁宁占位退到非当前态（无残影）
  await page.locator('.companion-pill.natsume').click()
  await expect(portrait.locator('img.natsume')).toHaveClass(/current/)
  await expect(portrait.locator('.companion-fallback.nene')).not.toHaveClass(/current/)
  await expect(portrait.locator('figcaption')).toHaveText('「今天的故事，由你来选。」')
  // 切回宁宁：失败角色重试一次（请求数 +1，非递归），仍失败则对应占位回归
  const hitsBefore = neneProbe.hits
  await page.locator('.companion-pill.nene').click()
  await expect(portrait.locator('figcaption')).toHaveText('「想和你一起，留住这一刻。」')
  await assertIntercepted(neneProbe, hitsBefore + 1)
  await expect(portrait.locator('img.nene')).toHaveCount(0)
  await expect(portrait.locator('.companion-fallback.nene')).toHaveClass(/current/)
  await expect(neneProbe.hits).toBe(hitsBefore + 1)
  await expect(portrait.locator('img.natsume')).toHaveJSProperty('naturalWidth', 1)
})

failureCase('P1', '404 页插图占位可读且返回入口可用并恢复', async (page, theme, testInfo) => {
  const probe = await intercept(page, '**/natsume-coffee*.webp*', notFound)
  await openWithTheme(page, '/no-such-page-glm', theme)
  await assertIntercepted(probe)
  // 失败态：插图换占位，标题、错误路径与三个返回入口保持可读可操作
  await expect(page.locator('img.notfound-chibi')).toHaveCount(0)
  await expect(page.locator('.notfound-chibi-fallback')).toBeVisible()
  await expect(page.locator('.notfound-chibi-fallback .notfound-fallback-text')).toHaveText('插图暂未加载')
  await expect(page.locator('.notfound-page h1')).toHaveText('页面走丢了')
  await expect(page.locator('.notfound-path')).toContainText('/no-such-page-glm')
  for (const label of ['回到首页', '去场景库', '去工作台']) {
    const link = page.getByRole('link', { name: label })
    await expect(link).toBeVisible()
    await expect(link).toBeEnabled()
  }
  await shot(page, testInfo, 'P1-failure', theme)
  // 恢复：解除 404 → 发放有效图 → 重载，插图真实解码且占位清零
  await page.unroute('**/natsume-coffee*.webp*')
  const restored = await intercept(page, '**/natsume-coffee*.webp*', pngFixture)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await assertIntercepted(restored)
  await expect(page.locator('img.notfound-chibi')).toHaveJSProperty('complete', true)
  await expect(page.locator('img.notfound-chibi')).not.toHaveJSProperty('naturalWidth', 0)
  await expect(page.locator('.notfound-chibi-fallback')).toHaveCount(0)
  await expect(page.locator('.notfound-page h1')).toHaveText('页面走丢了')
})

for (const viewport of [{ width: 1440, height: 960 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
  for (const theme of THEMES) {
    test(`illustration fallback layout ${viewport.width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize(viewport)
      await intercept(page, '**/assets/characters/*-home-cg-1024.webp', notFound)
      await openWithTheme(page, '/scene-explorer', theme)
      const portrait = page.locator('.scene-atlas-portrait')
      const text = portrait.locator('.companion-fallback.current .companion-fallback-text')
      await expect(text).toBeVisible()
      await portrait.scrollIntoViewIfNeeded()
      expect(await text.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
      const caption = portrait.locator('figcaption')
      if (viewport.width <= 768) {
        // 窄屏按当前画册布局隐藏台词，避免压缩角色占位；桌面才验证两层间距。
        await expect(caption).toBeHidden()
      } else {
        await expect(caption).toBeVisible()
        const separated = await portrait.evaluate(element => {
          const placeholder = element.querySelector('.companion-fallback.current .companion-fallback-text')!
          const captionElement = element.querySelector('figcaption')!
          const a = document.createRange(), b = document.createRange()
          a.selectNodeContents(placeholder); b.selectNodeContents(captionElement)
          return a.getBoundingClientRect().bottom + 4 <= b.getBoundingClientRect().top
        })
        expect(separated, '占位提示不得与台词重叠').toBe(true)
      }
      await portrait.screenshot({ path: info.outputPath(`scene-${viewport.width}-${theme}.png`) })
      await intercept(page, '**/natsume-coffee*.webp*', notFound)
      await page.goto('/no-such-page-glm', { waitUntil: 'domcontentloaded' })
      const missing = page.locator('.notfound-fallback-text')
      await expect(missing).toBeVisible()
      expect(await missing.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
      await page.screenshot({ path: info.outputPath(`notfound-${viewport.width}-${theme}.png`) })
      await page.getByRole('link', { name: '回到首页', exact: true }).click()
      await expect(page).toHaveURL(/\/$/)
      await expect(page.locator('.home-hero')).toBeVisible()
    })
  }
}

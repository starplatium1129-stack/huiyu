import { expect, test, type Page } from '@playwright/test'
import { installShowcaseFixture } from './helpers/showcase'

// Explicit CSS viewports, not physical-monitor or operating-system DPI claims.
test.use({ deviceScaleFactor: 1 })

async function prepare(page: Page, theme: string) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(theme => {
    localStorage.setItem('aics_theme', theme)
    localStorage.setItem('aics_pb_history', JSON.stringify(Array.from({ length: 8 }, (_, i) => ({
      id: `desktop-art-${i}`, sceneTitle: `夏日手记 ${i + 1}`, character: i % 2 ? 'natsume' : 'nene',
      prompt: 'Neutral layout fixture', image_url: `/assets/characters/${i % 2 ? 'natsume' : 'nene'}-home-cg-512.webp`,
      timestamp: Date.now() - i * 1000, width: 832, height: 1216, favorite: i < 2,
    }))))
    localStorage.setItem('aics_pb_projects', JSON.stringify([{ id: 'desktop-album', title: '夏日手记', history_ids: ['desktop-art-0', 'desktop-art-1'] }]))
  }, theme)
  await installShowcaseFixture(page)
}

async function noOverflow(page: Page) {
  await page.evaluate(() => document.fonts.ready)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
}

for (const theme of ['light', 'dark']) {
  for (const [width, height] of [[1920, 1080], [2560, 1440], [3840, 2160]]) {
    test(`desktop content and actions lead ${theme} ${width}`, async ({ page }, info) => {
      test.setTimeout(90_000)
      await prepare(page, theme)
      await page.setViewportSize({ width, height })
      for (const [path, card, overview] of [
        ['/gallery', '.artwork', '.gallery-album-overview'],
        ['/showcase', '.sample-visual', '.showcase-album-overview'],
      ]) {
        await page.goto(path)
        await expect(page.locator(card).first()).toBeVisible()
        await expect(page.locator(overview)).toBeHidden()
        if (path === '/gallery') {
          expect((await page.locator('.gallery-shell').boundingBox())!.width).toBeGreaterThan(width * .6)
          await expect(page.locator('.gallery-columns').first()).toHaveCSS('grid-template-columns', new RegExp(`^(\\S+\\s+){${width === 3840 ? 5 : width === 2560 ? 4 : 3}}\\S+$`))
        }
        const box = (await page.locator(card).first().boundingBox())!
        expect(box.y, `${path} first picture starts in the upper half`).toBeLessThan(height * .55)
        await noOverflow(page)
        await page.screenshot({ path: info.outputPath(`${path.slice(1)}-${width}.png`) })
        await page.getByRole('button', { name: /^按画册/ }).click()
        await expect(page.locator(overview)).toBeVisible()
        await expect(page.locator(card).first()).toBeHidden()
        const album = page.locator(overview).locator('[data-album-id]').first()
        const id = await album.getAttribute('data-album-id')
        await album.click()
        await expect(page.locator(card).first()).toBeVisible()
        await expect(page.locator(overview)).toBeHidden()
        await page.getByRole('button', { name: '返回画册', exact: true }).click()
        await expect(page.locator(overview).locator(`[data-album-id="${id}"]`)).toBeFocused()
      }

      await page.goto('/video-studio')
      const mode = page.getByRole('region', { name: '视频创作方式' })
      await expect(mode.getByRole('button')).toHaveCount(4)
      const generate = page.getByRole('button', { name: '生成视频', exact: true })
      await expect(generate).toBeInViewport({ ratio: .99 })
      await expect(page.getByRole('textbox', { name: '镜头描述', exact: true })).toBeInViewport({ ratio: .99 })
      const bar = (await page.locator('.video-generation-bar').boundingBox())!
      const editor = (await page.locator('#video-brief').boundingBox())!
      expect(bar.y + bar.height).toBeLessThanOrEqual(editor.y + 1)
      await noOverflow(page)
      await page.screenshot({ path: info.outputPath(`video-${width}.png`) })
      const advanced = page.locator('.video-creation-column .video-advanced')
      await advanced.locator(':scope > summary').click()
      await advanced.scrollIntoViewIfNeeded()
      await expect(generate).toBeInViewport({ ratio: .99 })

      await page.goto('/control?engine=anima')
      await expect(page.locator('.service-required')).toHaveCount(1)
      await expect(page.locator('.service-required')).toContainText('ComfyUI')
      await expect(page.locator('.status-tile .service-row-actions')).toHaveCount(4)
      expect((await page.locator('.control-shell').boundingBox())!.width).toBeGreaterThan(width * .6)
      await expect(page.locator('.service-required').getByRole('button', { name: '启动', exact: true })).toBeInViewport({ ratio: .99 })
      await noOverflow(page)
      await page.screenshot({ path: info.outputPath(`control-${width}.png`) })

      await page.goto('/prompt-builder')
      await page.getByRole('button', { name: '专家模式', exact: true }).click()
      await expect(page.locator('.engine-btn')).toHaveCount(3)
      await noOverflow(page)
      const engines = page.locator('.engine-switch')
      const railWidth = (await engines.boundingBox())!.width
      for (const button of await engines.getByRole('button').all()) {
        expect(Math.abs((await button.boundingBox())!.width - railWidth)).toBeLessThanOrEqual(1)
      }
      await page.getByRole('button', { name: '更多', exact: true }).click()
      const menu = page.getByRole('dialog', { name: '更多页面', exact: true })
      await expect(menu).toBeVisible()
      const menuBox = (await menu.boundingBox())!
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width)
      expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(height)
      await page.screenshot({ path: info.outputPath(`navigation-${width}.png`) })
      await page.keyboard.press('Escape')
    })
  }

  test(`character context survives profile and scene navigation ${theme}`, async ({ page }) => {
    await prepare(page, theme)
    await page.setViewportSize({ width: 1920, height: 1080 })
    for (const [id, target] of [['nene', '/scene-explorer'], ['sakurajima_mai', '/popular-scenes']]) {
      await page.goto(`/character?character=${id}`)
      const navigation = page.getByRole('navigation', { name: '角色内容导航', exact: true })
      const scenes = navigation.getByRole('link', { name: '角色场景', exact: true })
      await expect(scenes).toHaveAttribute('href', `${target}?character=${id}`)
      await scenes.click()
      await expect(page).toHaveURL(new RegExp(`${target}\\?character=${id}$`))
      await expect(page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('link', { name: '角色', exact: true })).toHaveAttribute('aria-current', 'page')
      await navigation.getByRole('link', { name: '角色档案', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/character\\?character=${id}$`))
    }
    await page.goto('/scene-explorer')
    await expect(page.getByRole('button', { name: '人设核心', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: /^完整库 / }).click()
    await expect(page.getByRole('button', { name: /^完整库 / })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: '人设核心', exact: true }).click()
    await expect(page.getByRole('button', { name: '人设核心', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.locator('#sceneSearch').fill('雨')
    await expect(page.locator('.scene-count')).toContainText('搜索结果')
  })
}

test('service recovery points to the active engine without starting services', async ({ page }) => {
  await prepare(page, 'dark')
  await page.goto('/prompt-builder')
  await page.getByRole('button', { name: '专家模式', exact: true }).click()
  await page.locator('.engine-btn').filter({ hasText: 'Anima 引擎' }).click()
  const recovery = page.locator('.api-recovery-link')
  await expect(recovery).toHaveAttribute('href', '/control?engine=anima')
  const writes: string[] = []
  await page.route('**/api/control', route => {
    writes.push(route.request().method())
    return route.fulfill({ json: { ok: true } })
  })
  await recovery.click()
  await expect(page.locator('.service-required')).toContainText('ComfyUI')
  expect(writes).toEqual([])
  await page.goto('/companion')
  await expect(page.locator('.live2d-enable-cta')).toBeVisible()
  await expect(page.locator('.avatar-status[data-state="idle"]')).toHaveCount(0)
})

// Browser simulations of effective desktop workspace sizes, not changes to Windows DPI.
for (const theme of ['light', 'dark']) for (const screen of [
  { name: '4k-150', width: 2560, height: 1440, dpr: 1.5 },
  { name: '4k-200', width: 1920, height: 1080, dpr: 2 },
  { name: '2k-125', width: 2048, height: 1152, dpr: 1.25 },
  { name: '1080p-125', width: 1536, height: 864, dpr: 1.25 },
]) {
  test(`desktop effective viewport ${theme} ${screen.name}`, async ({ browser, baseURL }, info) => {
    const context = await browser.newContext({ baseURL, viewport: { width: screen.width, height: screen.height }, deviceScaleFactor: screen.dpr })
    try {
      const page = await context.newPage()
      await prepare(page, theme)
      await page.goto('/video-studio')
      await expect(page.getByRole('button', { name: '生成视频', exact: true })).toBeInViewport({ ratio: .99 })
      await page.getByRole('combobox', { name: '选择视频画幅', exact: true }).click()
      const options = page.getByRole('listbox')
      await expect(options).toBeVisible()
      const box = (await options.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(screen.width)
      expect(box.y + box.height).toBeLessThanOrEqual(screen.height)
      await page.screenshot({ path: info.outputPath('video-menu.png') })
      await page.keyboard.press('Escape')
      await noOverflow(page)
      await page.goto('/gallery')
      await expect(page.locator('.artwork').first()).toBeVisible()
      expect((await page.locator('.artwork').first().boundingBox())!.y).toBeLessThan(screen.height * .6)
      await noOverflow(page)
      await page.goto('/lora')
      const launch = page.getByRole('link', { name: '用此角色绘制', exact: true }).first()
      await expect(launch).toBeInViewport({ ratio: .99 })
      await noOverflow(page)
      await info.attach('viewport.json', { body: JSON.stringify(await page.evaluate(() => ({ cssWidth: innerWidth, cssHeight: innerHeight, devicePixelRatio }))), contentType: 'application/json' })
    } finally { await context.close() }
  })
}

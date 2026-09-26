import { installDesktopHostFixture } from './helpers/desktopHost'
import { expect, test, type BrowserContext } from '@playwright/test'
import type { CompanionDesktopBridge } from '../../src/types/desktop'

// CSS viewport sizes represent Windows logical pixels; DPR models rendering scale.
// Native WebView2, monitor switching and OS window controls still need device acceptance.
const displays = [
  { name: 'minimum-window', width: 1024, height: 720, scale: 1 },
  { name: 'laptop', width: 1366, height: 768, scale: 1 },
  { name: '1080p-125', width: 1536, height: 864, scale: 1.25 },
  { name: '1080p-150', width: 1280, height: 720, scale: 1.5 },
  { name: '1440p-150', width: 1707, height: 960, scale: 1.5 },
  { name: 'wide-desktop', width: 2560, height: 1440, scale: 1 },
  { name: '4k-100', width: 3840, height: 2160, scale: 1 },
  { name: '4k-125', width: 3072, height: 1728, scale: 1.25 },
  { name: '4k-150', width: 2560, height: 1440, scale: 1.5 },
  { name: '4k-200', width: 1920, height: 1080, scale: 2 },
  { name: '4k-150-workarea', width: 2560, height: 1392, scale: 1.5 },
  { name: '4k-150-windowed', width: 1920, height: 1080, scale: 1.5 },
]

async function prepareDesktop(context: BrowserContext, theme: string) {
  await installDesktopHostFixture(context)
  await context.addInitScript(value => {
    localStorage.setItem('aics_theme', value)
    localStorage.setItem('aics_guest_guide_dismissed', '1')
    window.desktopCapabilitiesFixture = {
      isDesktop: true, getWindowState: async () => ({ maximized: false, focused: true }),
      onMaximizedChanged: () => 1, offMaximizedChanged: () => {},
      minimizeWindow: () => {}, toggleMaximizeWindow: () => {}, closeWindow: () => {},
    } as unknown as CompanionDesktopBridge
  }, theme)
}

for (const theme of ['dark', 'light']) {
  for (const display of displays) {
    test(`desktop workspace ${theme} ${display.name}`, async ({ browser }, info) => {
      const context = await browser.newContext({ viewport: { width: display.width, height: display.height }, deviceScaleFactor: display.scale, reducedMotion: 'reduce' })
      await prepareDesktop(context, theme)
      const page = await context.newPage()
      try {
        await page.goto(`${info.project.use.baseURL}/prompt-builder?scene=sc006`)
        await expect(page.locator('.desktop-titlebar')).toBeVisible()
        const generate = page.getByRole('button', { name: '生成图片', exact: true })
        await expect(page.locator('.workspace-archive-bar')).toBeVisible()
        const basic = await generate.boundingBox()
        expect(basic!.y + basic!.height).toBeLessThanOrEqual(display.height)
        await page.getByRole('button', { name: '专家模式', exact: true }).click()
        const materials = (await page.locator('#drawing-materials').boundingBox())!
        const canvas = (await page.locator('#drawing-canvas').boundingBox())!
        const inspector = (await page.locator('.director-inspector').boundingBox())!
        expect(materials.x + materials.width).toBeLessThanOrEqual(canvas.x)
        expect(canvas.x + canvas.width).toBeLessThanOrEqual(inspector.x)
        expect(Math.abs(materials.y - inspector.y)).toBeLessThan(2)
        const button = (await generate.boundingBox())!
        expect(button.y + button.height).toBeLessThanOrEqual(display.height)
        expect(inspector.y + inspector.height).toBeLessThanOrEqual(display.height)
        if (display.width >= 1920) {
          expect(inspector.x + inspector.width - materials.x).toBeGreaterThan(display.width * .94)
          expect(materials.width).toBeGreaterThanOrEqual(300)
          expect(inspector.width).toBeGreaterThanOrEqual(360)
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
        const list = page.locator('#stepScene > .scene-list')
        await expect(list.locator('.scene-card').first()).toBeVisible()
        const listBox = (await list.boundingBox())!
        const contentBox = (await page.locator('#material-scenes').boundingBox())!
        expect(contentBox.y + contentBox.height - listBox.y - listBox.height).toBeLessThanOrEqual(24)
        await list.hover()
        expect(Math.abs((await list.boundingBox())!.height - listBox.height)).toBeLessThan(2)
        const search = page.locator('#stepScene .scene-search')
        const searchTop = (await search.boundingBox())!.y
        await page.mouse.wheel(0, 500)
        await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
        expect(Math.abs((await search.boundingBox())!.y - searchTop)).toBeLessThan(2)
        const beforeCount = await list.locator('.scene-card').count()
        await list.locator('.scene-more').click()
        await expect(list.locator('.scene-card')).toHaveCount(beforeCount + 20)
        await list.locator('.scene-card').last().focus()
        await expect(list.locator('.scene-card').last()).toBeFocused()
        // At minimum height the list is 120px and a card can be ~127px. Native
        // focus centers that card, so its padding may overflow while all text fits.
        // Check the readable content, without forcing scrollTop or widening tolerance.
        await expect.poll(() => list.evaluate(el => {
          const viewport = el.getBoundingClientRect()
          const last = [...el.querySelectorAll('.scene-card')].at(-1)!
          const contents = [...last.children].map(child => child.getBoundingClientRect())
          return Math.max(...contents.flatMap(box => [viewport.top - box.top, box.bottom - viewport.bottom]))
        })).toBeLessThanOrEqual(1)
        await list.evaluate(el => { el.scrollTop = 0 })
        await page.getByRole('tab', { name: '提示词', exact: true }).click()
        await expect(page.locator('#inspector-tab-prompt')).toBeFocused()
        await page.screenshot({ path: info.outputPath('desktop-workspace.png') })
      } finally { await context.close() }
    })
  }
}

for (const theme of ['dark', 'light']) {
  for (const display of displays.filter(item => ['minimum-window', '4k-150'].includes(item.name))) {
    test(`desktop material scrolling and focus preserve context ${theme} ${display.name}`, async ({ browser }, info) => {
      const context = await browser.newContext({ viewport: { width: display.width, height: display.height }, deviceScaleFactor: display.scale, reducedMotion: 'reduce' })
      await prepareDesktop(context, theme)
      await context.addInitScript(() => {
        localStorage.setItem('aics_pb_director_mode', 'pro')
      })
      const page = await context.newPage()
      try {
        // Seed the actual repository before the app starts; direct workspace entry
        // does not run the home page's legacy localStorage history migration.
        await page.route('**/__layout-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Layout fixture</title>' }))
        await page.goto(`${info.project.use.baseURL}/__layout-fixture`)
        await page.evaluate(() => new Promise<void>((resolve, reject) => {
          const request = indexedDB.open('aics_kv_store', 1)
          request.onupgradeneeded = () => request.result.createObjectStore('kv', { keyPath: 'key' })
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result
            const transaction = db.transaction('kv', 'readwrite')
            transaction.objectStore('kv').put({ key: 'aics_pb_history', value: Array.from({ length: 12 }, (_, index) => ({
              id: index + 1, sceneTitle: `布局历史 ${index}`, timestamp: index + 1000,
              character: 'nene', prompt: 'isolated layout fixture', size: '832x1216',
            })) })
            transaction.oncomplete = () => { db.close(); resolve() }
            transaction.onabort = () => { db.close(); reject(transaction.error) }
          }
        }))
        await page.goto(`${info.project.use.baseURL}/prompt-builder?scene=sc006`)
        const search = page.locator('#stepScene .scene-search')
        await expect(search).toBeVisible()
        await search.fill('雨')
        await page.locator('[aria-controls="material-history"]').click()
        const history = page.locator('#material-history')
        await expect(history.locator('.history-item')).toHaveCount(12)
        expect(await history.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
        const firstItem = history.locator('.history-item').first()
        const firstBounds = (await firstItem.boundingBox())!
        for (const action of await firstItem.locator('.history-action').all()) {
          const bounds = (await action.boundingBox())!
          expect(bounds.x).toBeGreaterThanOrEqual(firstBounds.x)
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(firstBounds.x + firstBounds.width + 1)
        }
        await firstItem.locator('input[type="checkbox"]').check()
        await expect(history.getByRole('button', { name: '加入分镜 (1)', exact: true })).toBeVisible()
        expect(await history.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
        await history.getByRole('button', { name: '取消选择', exact: true }).click()
        const switchTop = (await page.locator('.material-switch').boundingBox())!.y
        const last = history.getByRole('button', { name: '继续', exact: true }).last()
        await last.focus()
        await expect.poll(() => history.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
        const lastBox = (await last.boundingBox())!
        const historyBox = (await history.boundingBox())!
        expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(historyBox.y + historyBox.height + 1)
        expect(Math.abs((await page.locator('.material-switch').boundingBox())!.y - switchTop)).toBeLessThan(2)
        expect(await page.locator('#drawing-materials').evaluate(el => el.scrollTop)).toBe(0)
        await page.screenshot({ path: info.outputPath('desktop-history-scroll.png') })

        await page.locator('[aria-controls="material-scenes"]').click()
        await expect(search).toHaveValue('雨')
        await page.getByRole('button', { name: '进入专注成片模式', exact: true }).click()
        await expect(page.locator('#drawing-materials')).toBeHidden()
        await expect(page.locator('.director-inspector')).toBeHidden()
        const canvas = (await page.locator('#drawing-canvas').boundingBox())!
        const workspace = (await page.locator('.director-workspace').boundingBox())!
        expect(Math.abs(canvas.width - workspace.width)).toBeLessThan(2)
        const generate = (await page.getByRole('button', { name: '生成图片', exact: true }).boundingBox())!
        expect(generate.y + generate.height).toBeLessThanOrEqual(display.height)
        await page.screenshot({ path: info.outputPath('desktop-focus.png') })
        await page.getByRole('button', { name: '退出专注成片模式', exact: true }).click()
        await expect(search).toHaveValue('雨')
        await page.getByRole('button', { name: '场景模式', exact: true }).click()
        await expect(search).toHaveValue('雨')
        await expect(page.locator('.director-inspector')).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      } finally { await context.close() }
    })
  }
}

test.beforeEach(async ({ page }) => { await installDesktopHostFixture(page) })

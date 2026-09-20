import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
type PetFixtureWindow = Window & { petFixture: { open: number; hide: number; closeChat: number; pass: boolean; send(payload: { command: string; character: string; text: string }): void } }

async function desktop(page: Page, theme: string, live = false) {
  // The dev asset proxy can point at an older installed gateway; inspect this checkout's bootstrap.
  await page.route('**/assets/theme-bootstrap.js', route => route.fulfill({ path: 'assets/theme-bootstrap.js', contentType: 'text/javascript' }))
  await page.route(/^http:\/\/[^/]+\/api\/(?!live2d)/, route => route.fulfill({ json: { ok: true, online: false, models: [] } }))
  await page.route('**/api/chat-status', route => route.fulfill({ json: { online: true, models: [{ name: 'fixture' }], model: 'fixture' } }))
  await page.route('**/api/chat', route => route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'token', content: '我就在这里。' + '这是一段用于检查气泡换行的完整回复。'.repeat(6) }) + '\n{"type":"done"}\n' }))
  await page.addInitScript(({ theme, live }) => {
    localStorage.setItem('aics_theme', theme)
    localStorage.setItem('aics_live2d_quality_v1', 'compact')
    localStorage.setItem('aics_companion_behavior_v1', JSON.stringify({ enabled: false, dnd: true }))
    localStorage.setItem('aics_companion_live2d_v1', String(live))
    localStorage.setItem('aics_chat_v1', JSON.stringify({ version: 3, active: 'natsume', histories: {}, settings: { autoVoice: false, chatProvider: 'local' } }))
    const fixture = { open: 0, hide: 0, closeChat: 0, docked: true, pass: false, send: (_payload: unknown) => {} }
    Object.assign(window, { petFixture: fixture })
    const methods: Record<string, unknown> = {
      isDesktop: true,
      getState: async () => ({ visible: true, alwaysOnTop: false, ignoreMouseEvents: false, live2dEnabled: live, bounds: { x: 0, y: 0, width: innerWidth, height: innerHeight } }),
      getSettings: async () => ({ openAtLogin: false }), getWorkspace: async () => ({ root: '', exists: false }), isPackaged: async () => true,
      getWindowState: async () => ({ maximized: false, focused: true }), getWindowZoom: async () => 1,
      openChat: async () => { fixture.open++ }, hide: () => { fixture.hide++ },
      hideChatWindow: async () => { fixture.closeChat++ }, getChatDocked: async () => fixture.docked,
      setChatDocked: async (value: boolean) => { fixture.docked = value; return value },
      setIgnoreMouseEvents: (value: boolean) => { fixture.pass = value },
      onChatCommand: (handler: typeof fixture.send) => { fixture.send = handler; return 1 },
    }
    window.companionDesktop = new Proxy(methods, { get(target, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => 1; return () => undefined } }) as unknown as NonNullable<Window['companionDesktop']>
  }, { theme, live })
  await page.goto('/companion?character=natsume')
  await expect(page.locator('html')).toHaveClass(/companion-desktop/)
}

test('native pet window keeps the frameless transparent builder contract', () => {
  const source = readFileSync('desktop-tauri/src-tauri/src/main_shared.rs', 'utf8')
  const pet = source.slice(source.indexOf('pub fn create_companion_window'), source.indexOf('pub fn open_companion_chat'))
  for (const flag of ['.transparent(true)', '.decorations(false)', '.shadow(false)', '.skip_taskbar(true)']) expect(pet).toContain(flag)
})

for (const theme of ['light', 'dark']) {
  test(`separate chat panel preserves drafts and dock controls ${theme}`, async ({ page }, testInfo) => {
    await desktop(page, theme)
    await page.goto('/companion-chat')
    const input = page.locator('.companion-chat-input')
    await input.fill('这段草稿暂时不发送')
    for (const width of [480, 360]) {
      await page.setViewportSize({ width, height: 640 })
      await expect(page.locator('.companion-chat-send')).toBeInViewport()
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`chat-panel-${theme}-${width}.png`) })
    }
    await page.getByRole('button', { name: '解除贴靠', exact: true }).click()
    await expect(page.getByRole('button', { name: '贴靠桌宠', exact: true })).toBeVisible()
    await expect(input).toHaveValue('这段草稿暂时不发送')
    await page.getByRole('button', { name: '关闭聊天窗', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as PetFixtureWindow).petFixture.closeChat)).toBe(1)
  })
  test(`pet stays transparent before application mount ${theme}`, async ({ page }) => {
    await page.addInitScript(theme => { localStorage.setItem('aics_theme', theme); Object.assign(window, { companionDesktop: { isDesktop: true } }) }, theme)
    await page.route('**/assets/theme-bootstrap.js', route => route.fulfill({ path: 'assets/theme-bootstrap.js', contentType: 'text/javascript' }))
    await page.route('**/*', route => route.request().resourceType() === 'script' && !route.request().url().includes('theme-bootstrap') ? route.abort() : route.fallback())
    await page.goto('/companion')
    await expect(page.locator('#app')).toBeEmpty()
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    expect(await page.locator('#app').evaluate(el => getComputedStyle(el, '::before').display)).toBe('none')
    await page.goto('/chat')
    expect(await page.locator('#app').evaluate(el => getComputedStyle(el, '::before').display)).toBe('grid')
  })
  test(`frameless pet controls, quiet state and reply ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 480, height: 720 })
    await desktop(page, theme)
    for (const selector of ['html', 'body', '#app', '.companion-page', '.companion-stage', '.character-card', '.portrait-stage']) {
      const style = await page.locator(selector).evaluate(el => ({ background: getComputedStyle(el).backgroundColor, image: getComputedStyle(el).backgroundImage }))
      expect(style.background, selector).toBe('rgba(0, 0, 0, 0)')
      expect(style.image, selector).toBe('none')
    }
    await expect(page.locator('[data-tauri-drag-region]')).toBeVisible()
    await expect(page.locator('.portrait-main')).toBeHidden()
    await page.mouse.move(10, 110)
    await expect(page.locator('.companion-page')).toHaveAttribute('data-ui-hidden', 'true', { timeout: 8000 })
    await expect(page.locator('.companion-toolbar')).toHaveCSS('opacity', '0')
    await page.screenshot({ path: testInfo.outputPath(`pet-quiet-${theme}.png`), omitBackground: true })
    await page.mouse.move(240, 360)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '鼠标穿透', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as PetFixtureWindow).petFixture.pass)).toBe(true)
    await page.keyboard.press('Escape')
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('aics_companion_chat_live_v1') || '{}').chatReady)).toBe(true)
    await page.evaluate(() => (window as PetFixtureWindow).petFixture.send({ command: 'send', character: 'natsume', text: '气泡测试' }))
    await expect(page.locator('.companion-reply-preview')).toContainText('我就在这里')
    await expect(page.locator('.companion-reply-preview')).toHaveCSS('opacity', '1')
    const stage = await page.locator('.live2d-host').boundingBox()
    await page.screenshot({ path: testInfo.outputPath(`pet-reply-${theme}.png`), omitBackground: true })
    await page.getByRole('button', { name: '展开完整回复', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as PetFixtureWindow).petFixture.open)).toBe(1)
    await page.getByRole('button', { name: '收起回复气泡', exact: true }).click()
    await expect(page.locator('.companion-reply-preview')).toHaveCount(0)
    expect(await page.locator('.live2d-host').boundingBox()).toEqual(stage)
    await page.mouse.move(250, 370)
    await page.getByRole('button', { name: '隐藏桌宠', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as PetFixtureWindow).petFixture.hide)).toBe(1)
    await page.setViewportSize({ width: 360, height: 520 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.getByRole('button', { name: '隐藏桌宠', exact: true })).toBeInViewport()
  })

  test(`frameless pet real models and transparent corners ${theme}`, async ({ page }, testInfo) => {
    test.skip(process.env.AICS_LIVE2D_IMPORTS !== '1', 'Requires private local assets')
    test.setTimeout(150000)
    await page.setViewportSize({ width: 480, height: 720 })
    await desktop(page, theme, true)
    for (const id of ['natsume', 'hatsune_miku', 'frieren']) {
      await page.mouse.move(20, 110)
      await page.getByRole('combobox', { name: '切换陪伴角色', exact: true }).selectOption(id)
      await expect(page.locator('.live2d-host')).toHaveAttribute('data-state', 'ready', { timeout: 45000 })
      await expect(page.locator('.live2d-host canvas')).toBeVisible()
      await expect(page.locator('.live2d-host')).toHaveCSS('filter', 'none')
      await page.waitForTimeout(700)
      const shot = await page.screenshot({ path: testInfo.outputPath(`pet-live-${id}-${theme}.png`), omitBackground: true })
      const alpha = await page.evaluate(async data => {
        const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode()
        const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height
        const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0)
        return [[1,1],[img.width-2,1],[1,img.height-2],[img.width-2,img.height-2]].map(([x,y]) => ctx.getImageData(x,y,1,1).data[3])
      }, shot.toString('base64'))
      expect(alpha).toEqual([0,0,0,0])
    }
  })
}

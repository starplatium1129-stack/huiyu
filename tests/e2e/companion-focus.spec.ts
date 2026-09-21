import { test, expect, type Locator, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'

async function desktopFixture(page: Page, theme: string, failRelay = false, credentials = false) {
  await page.addInitScript(({ theme, failRelay, credentials }) => {
    localStorage.setItem('aics_theme', theme)
    if (failRelay) localStorage.setItem('aics_companion_chat_live_v1', JSON.stringify({ activeChar: 'nene', chatReady: true, busy: false, ts: Date.now() }))
    localStorage.setItem('aics_companion_live2d_v1', 'false')
    localStorage.setItem('aics_companion_behavior_v1', JSON.stringify({ enabled: true, quietStartHour: 0, quietEndHour: 0, dnd: false }))
    const methods: Record<string, unknown> = {
      isDesktop: true,
      getState: async () => ({ visible: true, alwaysOnTop: false, ignoreMouseEvents: false, live2dEnabled: false }),
      getSettings: async () => ({ openAtLogin: false }),
      getWorkspace: async () => ({ root: '', exists: false }),
      getWindowState: async () => ({ maximized: false, focused: true }),
      getWindowZoom: async () => 1,
      setWindowZoom: async (value: number) => value,
      toggleAlwaysOnTop: async () => false, isPackaged: async () => true,
      chatRelay: async () => { if (failRelay) throw new Error('temporary bridge failure') },
    }
    if (credentials) {
      const vault = new Map<string, string>()
      methods.readChatCredential = async (endpoint: string) => vault.get(endpoint) || null
      methods.writeChatCredential = async (endpoint: string, secret: string) => { if (secret) vault.set(endpoint, secret); else vault.delete(endpoint) }
    }
    window.companionDesktop = new Proxy(methods, { get(target, key: string) {
      if (key in target) return target[key]
      if (key.startsWith('on')) return () => 1
      return () => undefined
    } }) as unknown as NonNullable<Window['companionDesktop']>
  }, { theme, failRelay, credentials })
}

/** Sample the actual gradient behind each text run, preserving layout and surfaces. */
async function paintedTextContrast(locator: Locator) {
  await expect(locator).toBeVisible()
  await locator.evaluate(async element => {
    const animations: Animation[] = []
    for (let node: Element | null = element; node; node = node.parentElement) {
      animations.push(...node.getAnimations().filter(item => item.effect?.getComputedTiming().iterations !== Infinity))
    }
    await Promise.all(animations.map(item => item.finished.catch(() => undefined)))
  })
  const measurement = await locator.evaluate(element => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')!
    context.fillStyle = getComputedStyle(element).color; context.fillRect(0, 0, 1, 1)
    const foreground = [...context.getImageData(0, 0, 1, 1).data]
    let opacity = 1
    for (let node: Element | null = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity)
    const bounds = element.getBoundingClientRect()
    const rects: Array<{ x: number; y: number; width: number; height: number }> = []
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent?.trim()) continue
      const range = document.createRange(); range.selectNodeContents(walker.currentNode)
      for (const rect of range.getClientRects()) rects.push({ x: rect.x - bounds.x, y: rect.y - bounds.y, width: rect.width, height: rect.height })
    }
    return { foreground, opacity, rects, width: bounds.width, height: bounds.height, style: element.getAttribute('style') }
  })
  let screenshot: Buffer
  try {
    await locator.evaluate(element => {
      const style = (element as HTMLElement).style
      style.setProperty('color', 'transparent', 'important'); style.setProperty('text-shadow', 'none', 'important')
    })
    screenshot = await locator.screenshot({ animations: 'disabled' })
  } finally {
    await locator.evaluate((element, style) => { if (style === null) element.removeAttribute('style'); else element.setAttribute('style', style) }, measurement.style)
  }
  return locator.evaluate(async (_element, { encoded, measurement }) => {
    const image = new Image(); image.src = `data:image/png;base64,${encoded}`; await image.decode()
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, image.width, image.height).data
    const luminance = (color: number[]) => color.slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
    const sx = image.width / measurement.width, sy = image.height / measurement.height
    const alpha = measurement.foreground[3] / 255 * measurement.opacity
    let minimum = Infinity
    for (const rect of measurement.rects) for (let y = rect.y + 2; y < rect.y + rect.height - 2; y += 2) for (let x = rect.x + 2; x < rect.x + rect.width - 2; x += 2) {
      const px = Math.floor(x * sx), py = Math.floor(y * sy)
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue
      const offset = (py * image.width + px) * 4
      const background = Array.from(pixels.slice(offset, offset + 3))
      const foreground = background.map((value, i) => measurement.foreground[i] * alpha + value * (1 - alpha))
      const a = luminance(foreground), b = luminance(background)
      minimum = Math.min(minimum, (Math.max(a, b) + .05) / (Math.min(a, b) + .05))
    }
    return minimum
  }, { encoded: screenshot!.toString('base64'), measurement })
}

for (const desktop of [false, true]) for (const theme of ['dark', 'light']) for (const width of [1440, 390]) {
  test(`personal API credential controls ${desktop ? 'desktop' : 'web'} ${theme} ${width}`, async ({ page }) => {
    if (desktop) await desktopFixture(page, theme, false, true)
    await page.addInitScript(theme => {
      localStorage.setItem('aics_theme', theme)
      localStorage.setItem('aics_chat_v1', JSON.stringify({ version: 3, active: 'nene', histories: {}, settings: {
        provider: 'api', apiBaseUrl: 'https://neutral-credential.example/v1', apiModel: 'fixture', apiKey: '', apiConfiguredByUser: true, live2dEnabled: false,
      } }))
    }, theme)
    const unexpectedWrites: string[] = []
    await page.route('**/api/chat-provider/**', async route => {
      if (route.request().method() !== 'GET') unexpectedWrites.push(route.request().url())
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ configured: false }) })
    })
    await page.route('**/api/chat-status', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ online: false, model: '', models: [] }) }))
    await page.route('https://neutral-credential.example/**', route => { unexpectedWrites.push(route.request().url()); return route.abort() })
    await page.setViewportSize({ width, height: 960 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/chat')
    await page.locator('.room-model-settings > summary').click()
    await page.locator('.api-settings-toggle').click()
    const panel = page.locator('.api-settings')
    await expect.poll(() => panel.evaluate(element => element.clientHeight >= element.scrollHeight - 1)).toBe(true)
    const key = panel.getByLabel('API Key')
    await expect(panel.locator('.api-storage-note')).toHaveText(desktop ? '密钥由 Windows 安全保存' : '密钥仅用于当前页面会话')
    await key.fill('neutral-ui-key')
    await panel.locator('[data-vendor="deepseek"]').click()
    await panel.locator('[data-vendor="custom"]').click()
    await expect(key).toHaveValue('neutral-ui-key')
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('neutral-ui-key')
    await panel.getByRole('button', { name: '保存并使用', exact: true }).click()
    await expect(panel).toBeHidden()
    await page.locator('.api-settings-toggle').click()
    await expect(key).toHaveValue('neutral-ui-key')
    if (desktop) expect(await page.evaluate(() => window.companionDesktop!.readChatCredential!('https://neutral-credential.example/v1'))).toBe('neutral-ui-key')
    await panel.getByRole('button', { name: '清除个人密钥', exact: true }).click()
    await expect(key).toHaveValue('')
    await expect(panel.locator('.api-test-status')).toHaveText('个人密钥已清除。')
    if (desktop) expect(await page.evaluate(() => window.companionDesktop!.readChatCredential!('https://neutral-credential.example/v1'))).toBeNull()
    await panel.locator('[data-vendor="deepseek"]').click()
    await panel.locator('[data-vendor="custom"]').click()
    await expect(key).toHaveValue('')
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('neutral-ui-key')
    const contrasts: Record<string, number> = {}
    for (const [name, locator] of [
      ['note', panel.locator('.api-storage-note')], ['clear', panel.getByRole('button', { name: '清除个人密钥', exact: true })], ['status', panel.locator('.api-test-status')],
    ] as const) {
      contrasts[name] = await paintedTextContrast(locator)
      expect(Number.isFinite(contrasts[name])).toBe(true)
      expect(contrasts[name], name).toBeGreaterThanOrEqual(4.5)
    }
    for (const button of await panel.locator('.api-settings-buttons button').all()) {
      const bounds = await button.boundingBox()
      expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width).toBeTruthy()
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    const directory = 'runtime/audit-handoff-2026-09-21/ui'
    mkdirSync(directory, { recursive: true })
    const name = `personal-api-${desktop ? 'desktop' : 'web'}-${theme}-${width}`
    // The chat viewport clips tall forms; capture both real scroll positions
    // instead of a locator image that can contain only the final status strip.
    await panel.locator('.api-settings-head').scrollIntoViewIfNeeded()
    await expect(panel.locator('.api-storage-note')).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: `${directory}/${name}.png`, animations: 'disabled' })
    await panel.locator('.api-settings-actions').scrollIntoViewIfNeeded()
    for (const button of await panel.locator('.api-settings-buttons button').all()) await expect(button).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: `${directory}/${name}-actions.png`, animations: 'disabled' })
    writeFileSync(`${directory}/${name}-contrast.json`, JSON.stringify(contrasts, null, 2))
    expect(unexpectedWrites).toEqual([])
  })
}

for (const theme of ['dark', 'light']) {
  for (const [width, height] of [[360, 520], [480, 720]]) {
    test(`companion character window ${theme} ${width}`, async ({ page }) => {
      await desktopFixture(page, theme)
      await page.setViewportSize({ width, height })
      await page.goto('/companion')
      // Pure-pet mode keeps chrome hidden until an explicit desktop gesture.
      // The old test assumed a permanently visible chat chip and stopped before
      // checking the current right-click / Shift+F10 contract.
      await expect(page.locator('.companion-chat-chip')).toBeHidden()
      await page.locator('.companion-page').click({ button: 'right', position: { x: 12, y: 12 } })
      await expect(page.locator('.companion-chat-chip')).toBeVisible()
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
      await page.getByRole('button', { name: '设置', exact: true }).click()
      const panel = page.locator('.companion-settings-popover')
      await expect(panel).toBeVisible()
      const contrast = await page.getByRole('combobox', { name: '切换陪伴角色' }).evaluate(element => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')!
        const rgb = (value: string) => { context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3) }
        const luminance = (color: number[]) => color.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
        const style = getComputedStyle(element)
        const foreground = luminance(rgb(style.color)), background = luminance(rgb(style.backgroundColor))
        return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05)
      })
      expect(contrast).toBeGreaterThanOrEqual(4.5)
      const bounds = await panel.boundingBox()
      expect(bounds && bounds.x >= 0 && bounds.y + bounds.height <= height).toBeTruthy()
      await page.screenshot({ path: `.review-shots/companion-focus-${theme}-${width}.png` })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
      await page.keyboard.press('Escape')
      await expect(panel).toBeHidden()
      await page.locator('.companion-page').press('Shift+F10')
      await expect(page.locator('.companion-chat-chip')).toBeVisible()
      await page.keyboard.press('Escape')
      const reminder = page.locator('.companion-float-reminder p').first()
      await expect(reminder).toBeVisible()
      const overlayContrast = await reminder.evaluate(element => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')!
        context.fillStyle = 'white'; context.fillRect(0, 0, 1, 1)
        context.fillStyle = getComputedStyle(element.parentElement!).backgroundColor; context.fillRect(0, 0, 1, 1)
        const luminance = (color: number[]) => color.slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
        const background = luminance([...context.getImageData(0, 0, 1, 1).data])
        context.fillStyle = getComputedStyle(element).color; context.fillRect(0, 0, 1, 1)
        const foreground = luminance([...context.getImageData(0, 0, 1, 1).data])
        return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05)
      })
      expect(overlayContrast).toBeGreaterThanOrEqual(4.5)
      await page.screenshot({ path: `.review-shots/companion-stage-${theme}-${width}.png` })
    })
    test(`companion chat window ${theme} ${width}`, async ({ page }) => {
      await desktopFixture(page, theme)
      await page.setViewportSize({ width, height })
      await page.goto('/companion-chat')
      await expect(page.locator('.companion-chat-input')).toBeVisible()
      await page.locator('.companion-chat-input').fill('这是一段较长的输入，用来检查小窗口内输入与操作按钮是否仍然清楚可用。')
      await page.screenshot({ path: `.review-shots/companion-chat-focus-${theme}-${width}.png` })
      const button = await page.locator('.companion-chat-send').boundingBox()
      expect(button && button.y + button.height <= height).toBeTruthy()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    })
  }
}

test('companion chat keeps drafts across status updates and IME confirmation', async ({ page }) => {
  await desktopFixture(page, 'dark', true)
  await page.goto('/companion-chat')
  const input = page.locator('.companion-chat-input')
  await input.fill('这份草稿应当保留')
  await page.evaluate(() => {
    localStorage.setItem('aics_companion_chat_live_v1', JSON.stringify({ activeChar: 'nene', chatReady: true, busy: false, ts: Date.now() }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'aics_companion_chat_live_v1' }))
  })
  await expect(input).toHaveValue('这份草稿应当保留')
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
  await expect(input).toHaveValue('这份草稿应当保留')
  await page.locator('.companion-chat-send').click()
  await expect(page.locator('.companion-chat-error')).toContainText('草稿已保留')
  await expect(input).toHaveValue('这份草稿应当保留')
  await page.evaluate(() => {
    localStorage.setItem('aics_companion_chat_live_v1', JSON.stringify({ activeChar: 'natsume', chatReady: true, busy: false, ts: Date.now() }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'aics_companion_chat_live_v1' }))
  })
  await expect(input).toHaveValue('')
  await page.evaluate(() => {
    localStorage.setItem('aics_companion_chat_live_v1', JSON.stringify({ activeChar: 'nene', chatReady: true, busy: false, ts: Date.now() }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'aics_companion_chat_live_v1' }))
  })
  await expect(input).toHaveValue('这份草稿应当保留')
})

test('companion chat rejects an unknown live character instead of borrowing another identity', async ({ page }) => {
  await desktopFixture(page, 'dark')
  await page.addInitScript(() => {
    localStorage.setItem('aics_companion_chat_live_v1', JSON.stringify({
      activeChar: 'removed-character', chatReady: true, busy: false, ts: Date.now(),
    }))
  })
  await page.goto('/companion-chat')
  await expect(page.locator('.companion-chat-window')).toHaveAttribute('data-character', 'nene')
  await expect(page.locator('.companion-chat-title')).toContainText('绫地宁宁')
  await page.evaluate(() => {
    localStorage.setItem('aics_companion_chat_live_v1', JSON.stringify({
      activeChar: 'unknown-again', chatReady: true, busy: false, ts: Date.now(),
    }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'aics_companion_chat_live_v1' }))
  })
  await expect(page.locator('.companion-chat-window')).toHaveAttribute('data-character', 'nene')
})

for (const theme of ['dark', 'light']) {
  test(`companion capability report explains pending and unsupported mappings in ${theme} theme`, async ({ page }) => {
    await desktopFixture(page, theme)
    await page.goto('/chat')
    await page.locator('.character-controls > summary').click()
    const report = page.locator('.live2d-capability-report')
    await expect(report.locator('summary')).toContainText('待实机')
    await report.locator('summary').click()
    await expect(report.locator('li')).toHaveCount(7)
    await expect(report).toContainText('口型')
    await expect(report).toContainText('ParamMouthOpenY')
    await page.getByRole('combobox', { name: '切换角色', exact: true }).selectOption('natsume')
    await expect(page.locator('.character-card')).toHaveAttribute('data-character', 'natsume')
    await expect(report).toContainText('ParamMouthForm3')
    await report.screenshot({ path: `.review-shots/companion-capabilities-${theme}.png` })
  })
}

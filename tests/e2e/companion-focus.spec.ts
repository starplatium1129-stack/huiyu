import { test, expect, type Page } from '@playwright/test'

async function desktopFixture(page: Page, theme: string, failRelay = false) {
  await page.addInitScript(({ theme, failRelay }) => {
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
    window.companionDesktop = new Proxy(methods, { get(target, key: string) {
      if (key in target) return target[key]
      if (key.startsWith('on')) return () => 1
      return () => undefined
    } }) as unknown as NonNullable<Window['companionDesktop']>
  }, { theme, failRelay })
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

import { test, expect } from '@playwright/test'

for (const theme of ['dark', 'light']) {
  for (const [width, height] of [[1440, 960], [390, 844]]) {
    test(`open room and immersive conversation ${theme} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
      await page.goto('/chat')
      await expect(page.getByRole('combobox', { name: '切换角色', exact: true })).toBeVisible()
      await page.locator('.chat-input').fill('这段草稿在切换布局时保留')
      await page.getByRole('button', { name: '专注陪伴', exact: true }).click()
      await expect(page.locator('.room-current-line')).toBeVisible()
      const panel = await page.locator('.conversation-card').boundingBox()
      expect(panel!.x).toBeGreaterThanOrEqual(0)
      expect(panel!.x + panel!.width).toBeLessThanOrEqual(width + 1)
      await expect(page.locator('.chat-input')).toHaveValue('这段草稿在切换布局时保留')
      await page.screenshot({ path: `runtime/room-redesign/immersive-${theme}-${width}.png` })
      await page.getByRole('button', { name: '展开对话', exact: true }).click()
      await expect(page.locator('.chat-list')).toBeVisible()
      const send = await page.locator('.send-btn').boundingBox()
      expect(send!.y + send!.height).toBeLessThanOrEqual(height)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
      await page.screenshot({ path: `runtime/room-redesign/room-${theme}-${width}.png` })
    })
  }
  test(`Miku real model uses an open stage in ${theme}`, async ({ page }) => {
    test.skip(process.env.AICS_LIVE2D_IMPORTS !== '1', 'Requires private local model assets')
    test.setTimeout(60000)
    await page.addInitScript(theme => { localStorage.setItem('aics_theme', theme); localStorage.setItem('aics_live2d_quality_v1', 'compact') }, theme)
    await page.goto('/chat?character=hatsune_miku')
    await expect(page.getByRole('combobox', { name: '切换角色', exact: true }).locator('option[value="raiden_shogun"]')).toHaveCount(0)
    const enable = page.locator('.live2d-enable-cta')
    await expect(enable).toBeVisible()
    await enable.click()
    await expect(page.locator('.live2d-host')).toHaveAttribute('data-state', 'ready', { timeout: 40000 })
    await expect(page.locator('.live2d-host canvas')).toBeVisible()
    await expect(page.locator('.voice-capability')).toContainText('文字聊天')
    await expect(page.locator('.room-setup')).toBeHidden()
    await page.waitForTimeout(500)
    await page.screenshot({ path: `runtime/room-redesign/miku-${theme}.png` })
    await page.getByRole('button', { name: '专注陪伴', exact: true }).click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `runtime/room-redesign/miku-immersive-${theme}.png` })
    await page.getByRole('button', { name: '展开对话', exact: true }).click()
    await page.locator('.character-controls > summary').click()
    await page.getByRole('slider', { name: '角色大小', exact: true }).fill('1.8')
    await page.reload()
    await page.locator('.character-controls > summary').click()
    await expect(page.getByRole('slider', { name: '角色大小', exact: true })).toHaveValue('1.8')
  })
  test(`real desktop character surface ${theme}`, async ({ page }) => {
    test.skip(process.env.AICS_LIVE2D_IMPORTS !== '1', 'Requires private local model assets')
    test.setTimeout(90000)
    await page.setViewportSize({ width: 480, height: 720 })
    await page.addInitScript(theme => {
      localStorage.setItem('aics_theme', theme)
      localStorage.setItem('aics_live2d_quality_v1', 'compact')
      localStorage.setItem('aics_companion_behavior_v1', JSON.stringify({ enabled: false, dnd: true }))
      const methods: Record<string, unknown> = {
        isDesktop: true, getState: async () => ({ visible: true, live2dEnabled: true, bounds: { x: 0, y: 0, width: 480, height: 720 } }),
        getSettings: async () => ({}), getWorkspace: async () => ({ root: '', exists: false }), isPackaged: async () => true,
      }
      window.companionDesktop = new Proxy(methods, { get(target, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => 1; return () => undefined } }) as unknown as NonNullable<Window['companionDesktop']>
    }, theme)
    await page.goto('/companion?character=hatsune_miku')
    for (const id of ['hatsune_miku', 'frieren', 'nene']) {
      await page.getByRole('combobox', { name: '切换陪伴角色' }).selectOption(id)
      await expect(page.locator('.live2d-host')).toHaveAttribute('data-state', 'ready', { timeout: 40000 })
      await expect(page.locator('.live2d-host canvas')).toBeVisible()
      await page.waitForTimeout(500)
      await page.screenshot({ path: `runtime/room-redesign/pet-${id}-${theme}.png`, omitBackground: true })
    }
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '角色取景与外观', exact: true }).click()
    await expect(page.getByRole('slider', { name: '角色大小', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('slider', { name: '角色大小', exact: true })).toBeHidden()
  })
}

test('reading an older message is stable and the latest shortcut follows new content', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('aics_chat_v1', JSON.stringify({
    version: 3, active: 'nene', histories: { nene: Array.from({ length: 16 }, (_, i) => ({ mid: `read-${i}`, role: i % 2 ? 'assistant' : 'user', content: `第 ${i} 条对话。` + '这是一段用于验证阅读位置的消息。'.repeat(5), stopped: false })) },
    settings: { autoVoice: false },
  })))
  await page.goto('/companion-chat')
  const list = page.locator('.companion-chat-bubbles')
  await expect(list.locator('.companion-chat-bubble')).toHaveCount(16)
  await list.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('aics_chat_v1')!)
    state.histories.nene.push({ mid: 'new-message', role: 'assistant', content: '这是新到的一句话。', stopped: false })
    localStorage.setItem('aics_chat_v1', JSON.stringify(state))
    window.dispatchEvent(new StorageEvent('storage', { key: 'aics_chat_v1', newValue: JSON.stringify(state) }))
  })
  await expect(page.getByRole('button', { name: '回到最新消息' })).toBeVisible()
  expect(await list.evaluate(el => el.scrollTop)).toBe(0)
  await page.getByRole('button', { name: '回到最新消息' }).click()
  await expect(list.locator('.companion-chat-bubble').last()).toBeInViewport()
})

test('opening the full room carries the selected character and an unsaved draft', async ({ page }) => {
  await page.goto('/companion-chat')
  await page.getByRole('combobox', { name: '切换角色', exact: true }).selectOption('natsume')
  await page.locator('.companion-chat-input').fill('继续这段还没发送的对话')
  await page.getByRole('button', { name: '打开完整房间', exact: true }).click()
  await expect(page.getByRole('combobox', { name: '切换角色', exact: true })).toHaveValue('natsume')
  await expect(page.locator('.chat-input')).toHaveValue('继续这段还没发送的对话')
})

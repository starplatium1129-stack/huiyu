import { expect, test } from '@playwright/test'
import { textContrast } from './helpers/contrast'

for (const theme of ['light', 'dark']) {
  test(`room editorial layout and draft continuity ${theme}`, async ({ page }, testInfo) => {
    await page.route(/^http:\/\/[^/]+\/api\/(?!live2d)/, route => route.fulfill({ json: { ok: true, online: false, models: [] } }))
    await page.addInitScript(theme => {
      localStorage.setItem('aics_theme', theme)
      localStorage.setItem('aics_chat_v1', JSON.stringify({ version: 3, active: 'natsume', histories: { natsume: [
        { mid: 'room-fixture-1', role: 'user', content: '今天终于把作品画完了。' },
        { mid: 'room-fixture-2', role: 'assistant', content: '辛苦了。要先聊聊，还是一起休息一会儿？' },
      ] }, settings: { autoVoice: false } }))
    }, theme)
    await page.goto('/chat?character=natsume')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.getByRole('heading', { name: '此刻，与你' })).toBeVisible()
    await page.locator('.chat-input').fill('切换布局仍保留这段草稿')
    for (const width of [1440, 1280, 820, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const input = (await page.locator('.chat-composer').boundingBox())!
      expect(input.y + input.height).toBeLessThanOrEqual(901)
      await expect(page.getByRole('button', { name: '新对话', exact: true })).toBeVisible()
      for (const selector of ['.room-title', '.room-conversation-title strong', '.message-bubble']) {
        expect(await page.locator(selector).first().evaluate(textContrast), selector).toBeGreaterThanOrEqual(4.5)
      }
      await page.screenshot({ path: testInfo.outputPath(`room-${theme}-${width}.png`) })
      await page.getByRole('button', { name: '专注陪伴', exact: true }).click()
      await expect(page.locator('.room-current-line')).toBeVisible()
      await expect(page.locator('.chat-input')).toHaveValue('切换布局仍保留这段草稿')
      await page.getByRole('button', { name: '展开对话', exact: true }).click()
    }
  })

  test(`room editorial real models ${theme}`, async ({ page }, testInfo) => {
    test.skip(process.env.AICS_LIVE2D_IMPORTS !== '1', 'Explicit local real-model inspection only')
    test.setTimeout(150000)
    await page.route(/^http:\/\/[^/]+\/api\/(?!live2d)/, route => route.fulfill({ json: { ok: true, online: false, models: [] } }))
    await page.addInitScript(theme => { localStorage.setItem('aics_theme', theme); localStorage.setItem('aics_live2d_quality_v1', 'compact') }, theme)
    await page.goto('/chat?character=natsume')
    for (const id of ['natsume', 'hatsune_miku', 'frieren', 'nene']) {
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.getByRole('combobox', { name: '切换角色', exact: true }).selectOption(id)
      const enable = page.locator('.live2d-enable-cta')
      if (await enable.isVisible()) await enable.click()
      await expect(page.locator('.live2d-host')).toHaveAttribute('data-state', 'ready', { timeout: 45000 })
      await expect(page.locator('.live2d-host canvas')).toBeVisible()
      await page.waitForTimeout(800)
      await page.screenshot({ path: testInfo.outputPath(`room-live-${id}-${theme}.png`) })
      await page.locator('.character-controls > summary').click()
      const zoom = page.getByRole('slider', { name: '角色大小', exact: true })
      await expect(zoom).toHaveValue(id === 'natsume' ? '0.9' : id === 'nene' ? '1.1' : '1')
      await zoom.fill('1.1')
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: '专注陪伴', exact: true }).click()
      await page.getByRole('button', { name: '展开对话', exact: true }).click()
      await page.locator('.character-controls > summary').click()
      await expect(zoom).toHaveValue('1.1')
      await page.getByRole('button', { name: '恢复默认取景', exact: true }).click()
      await page.keyboard.press('Escape')
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(page.locator('.live2d-host canvas')).toBeVisible()
      await expect(page.locator('.send-btn')).toBeInViewport()
      await page.waitForTimeout(300)
      await page.screenshot({ path: testInfo.outputPath(`room-live-${id}-${theme}-narrow.png`) })
    }
  })
}

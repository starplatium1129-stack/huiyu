import { installDesktopHostFixture } from './helpers/desktopHost'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { textContrast } from './helpers/contrast'
declare global {
  interface Window {
    petFixture?: { open: number; hide: number; closeChat: number; drag: number; docked: boolean; pass: boolean; pinned: boolean; send(payload: { command: string; character: string; text: string }): void }
  }
}

async function desktop(page: Page, theme: string, live = false) {
  // The dev asset proxy can point at an older installed gateway; inspect this checkout's bootstrap.
  await page.route('**/assets/theme-bootstrap.js', route => route.fulfill({ path: 'assets/theme-bootstrap.js', contentType: 'text/javascript' }))
  await page.route(/^http:\/\/[^/]+\/api\/(?!live2d)/, route => route.fulfill({ json: { ok: true, online: false, models: [] } }))
  await page.route('**/api/chat-status', route => route.fulfill({ json: { online: true, models: [{ name: 'fixture' }], model: 'fixture' } }))
  if (!live) await page.route('**/api/live2d-status', route => route.fulfill({ json: { models: {} } }))
  await page.route('**/api/chat', route => route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'token', content: '我就在这里。' + '这是一段用于检查气泡换行的完整回复。'.repeat(6) }) + '\n{"type":"done"}\n' }))
  await page.addInitScript(({ theme, live }) => {
    localStorage.setItem('aics_theme', theme)
    localStorage.setItem('aics_live2d_quality_v1', 'compact')
    localStorage.setItem('aics_companion_behavior_v1', JSON.stringify({ enabled: false, dnd: true }))
    localStorage.setItem('aics_companion_live2d_v1', String(live))
    localStorage.setItem('aics_chat_v1', JSON.stringify({ version: 3, active: 'natsume', histories: {}, settings: { autoVoice: false, provider: 'local' } }))
    const fixture = { open: 0, hide: 0, closeChat: 0, drag: 0, docked: true, pass: false, pinned: false, send: (_payload: unknown) => {} }
    Object.assign(window, { petFixture: fixture })
    const methods: Record<string, unknown> = {
      isDesktop: true,
      getState: async () => ({ visible: true, alwaysOnTop: false, ignoreMouseEvents: false, live2dEnabled: live, bounds: { x: 0, y: 0, width: innerWidth, height: innerHeight } }),
      getSettings: async () => ({ openAtLogin: false }), getWorkspace: async () => ({ root: '', exists: false }), isPackaged: async () => true,
      getWindowState: async () => ({ maximized: false, focused: true }), getWindowZoom: async () => 1,
      openChat: async () => { fixture.open++ }, hide: () => { fixture.hide++ },
      startDragging: async () => { fixture.drag++ },
      toggleAlwaysOnTop: async () => { fixture.pinned = !fixture.pinned; return fixture.pinned },
      hideChatWindow: async () => { fixture.closeChat++ }, getChatDocked: async () => fixture.docked,
      setChatDocked: async (value: boolean) => { fixture.docked = value; return value },
      setIgnoreMouseEvents: (value: boolean) => { fixture.pass = value },
      onChatCommand: (handler: typeof fixture.send) => { fixture.send = handler; return 1 },
    }
    window.desktopCapabilitiesFixture = new Proxy(methods, { get(target, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => 1; return () => undefined } }) as unknown as NonNullable<Window['desktopCapabilitiesFixture']>
  }, { theme, live })
  await page.goto('/companion?character=natsume')
  await expect(page.locator('html')).toHaveClass(/companion-desktop/)
}

async function settledOrbit(page: Page) {
  const orbit = page.getByRole('region', { name: '桌宠环形菜单', exact: true })
  await expect(orbit).toBeVisible()
  await expect(orbit).toHaveCSS('opacity', '1')
  await expect(orbit).toHaveCSS('transform', 'none')
  return orbit
}

/** The button is transparent; its actual painted backdrop is its sibling sector. */
async function sectorTextContrast(button: Locator) {
  const previous = await button.evaluate(element => {
    const style = element.getAttribute('style')
    const sector = element.parentElement!.querySelector(':scope > svg > path')!
    ;(element as HTMLElement).style.setProperty('background-color', getComputedStyle(sector).fill, 'important')
    return style
  })
  try { return await button.locator('span').evaluate(textContrast) }
  finally { await button.evaluate((element, style) => { if (style === null) element.removeAttribute('style'); else element.setAttribute('style', style) }, previous) }
}

for (const theme of ['light', 'dark']) {
  for (const viewport of [{ width: 540, height: 760 }, { width: 360, height: 480 }]) {
    test(`orbit menu geometry, keyboard and actions ${theme} ${viewport.width}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport)
      await desktop(page, theme)
      const host = page.locator('.live2d-host')
      const before = await host.boundingBox()
      expect(before).not.toBeNull()
      await page.locator('.companion-page').focus()
      await page.keyboard.press('Shift+F10')
      const orbit = await settledOrbit(page)
      await expect(orbit.getByRole('button', { name: '收起桌宠菜单' })).toBeFocused()
      for (const name of ['设置', '打开聊天', '切换陪伴角色', '角色表情', '互动动作', '置顶窗口', '鼠标穿透', '隐藏桌宠']) {
        const button = orbit.getByRole('button', { name, exact: true })
        await expect(button).toBeInViewport({ ratio: 1 })
        await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
        expect(await sectorTextContrast(button), name).toBeGreaterThanOrEqual(4.5)
        expect(await button.evaluate(el => {
          const r = el.getBoundingClientRect()
          return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
        }), `${name} can receive pointer input`).toBe(true)
      }
      const action = orbit.getByRole('button', { name: '设置', exact: true })
      const sector = action.locator('..').locator(':scope > svg > path')
      const edge = await sector.evaluate(element => {
        const path = element as SVGPathElement, point = path.getPointAtLength(path.getTotalLength() * .05)
        const inside = new DOMPoint(220 + (point.x - 220) * .97, 220 + (point.y - 220) * .97).matrixTransform(path.getScreenCTM()!)
        return { x: inside.x, y: inside.y }
      })
      await page.mouse.move(edge.x, edge.y)
      expect(await sector.evaluate(element => element.matches(':hover'))).toBe(true)
      await expect(action).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      const hoveredFill = await sector.evaluate(element => getComputedStyle(element).fill)
      await action.locator('.archive-icon').hover()
      await expect(action).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      expect(await sector.evaluate(element => getComputedStyle(element).fill)).toBe(hoveredFill)
      expect(await sectorTextContrast(action)).toBeGreaterThanOrEqual(4.5)
      await page.screenshot({ path: testInfo.outputPath(`orbit-icon-hover-${theme}-${viewport.width}.png`), omitBackground: true })
      await page.mouse.move(2, viewport.height - 2)
      for (const selector of ['.orbit-kicker', '.orbit-heading strong', '.orbit-guide']) {
        expect(await orbit.locator(selector).evaluate(textContrast), selector).toBeGreaterThanOrEqual(4.5)
      }
      // The empty centre must remain available to the actual character stage.
      expect(await orbit.locator('.orbit-wheel').evaluate(el => {
        const r = el.getBoundingClientRect()
        return Boolean(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.portrait-stage'))
      })).toBe(true)
      expect(await host.boundingBox()).toEqual(before)
      await page.screenshot({ path: testInfo.outputPath(`orbit-main-${theme}-${viewport.width}.png`), omitBackground: true })
      const heading = await orbit.locator('.orbit-heading strong').boundingBox()
      expect(heading).not.toBeNull()
      await page.mouse.move(heading!.x + 4, heading!.y + 4)
      await page.mouse.down()
      await page.mouse.move(heading!.x + 36, heading!.y + 20, { steps: 4 })
      await page.mouse.up()
      await expect.poll(() => page.evaluate(() => window.petFixture!.drag)).toBe(0)
      await expect(orbit).toBeVisible()
      const pin = orbit.getByRole('button', { name: '置顶窗口', exact: true })
      await pin.click()
      await expect(pin).toHaveAttribute('aria-pressed', 'true')
      await expect.poll(() => page.evaluate(() => window.petFixture!.pinned)).toBe(true)
      expect(await sectorTextContrast(pin)).toBeGreaterThanOrEqual(4.5)
      await pin.click()
      await expect(pin).toHaveAttribute('aria-pressed', 'false')
      await orbit.getByRole('button', { name: '切换陪伴角色', exact: true }).click()
      await expect(orbit.getByRole('region', { name: '陪伴角色', exact: true })).toBeVisible()
      if (viewport.width === 360) {
        await expect(orbit.locator('.orbit-wheel')).toHaveCount(0)
        await expect(orbit.locator('.orbit-option-list')).toBeVisible()
        await expect(orbit.getByRole('button', { name: '绫地宁宁', exact: true })).toBeInViewport({ ratio: 1 })
      } else await expect(orbit.locator('.orbit-option').first()).toBeVisible()
      for (const option of await orbit.locator('.orbit-option span, .orbit-option-list button > span').all()) {
        expect(await option.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
        expect(await option.evaluate(element => {
          const button = element.closest('button')!.getBoundingClientRect(), bounds = element.getBoundingClientRect()
          const range = document.createRange(); range.selectNodeContents(element)
          return element.scrollHeight <= element.clientHeight + 1 && [...range.getClientRects()].every(rect =>
            rect.top >= Math.max(button.top, bounds.top) - 1 && rect.bottom <= Math.min(button.bottom, bounds.bottom) + 1)
        }), 'character names fit vertically inside their cards').toBe(true)
      }
      if (viewport.width === 540) {
        await expect(orbit.getByRole('button', { name: '绫地宁宁', exact: true }).locator('span')).toHaveText('宁宁')
        await expect(orbit.getByRole('button', { name: '四季夏目', exact: true }).locator('span')).toHaveText('夏目')
      }
      expect(await orbit.locator('.orbit-selection > header strong').evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
      expect(await orbit.locator('.orbit-selection > header > span').evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
      expect(await host.boundingBox()).toEqual(before)
      await page.screenshot({ path: testInfo.outputPath(`orbit-characters-${theme}-${viewport.width}.png`), omitBackground: true })
      await page.keyboard.press('Escape')
      await expect(orbit.getByRole('region', { name: '陪伴角色', exact: true })).toHaveCount(0)
      await expect(orbit.getByRole('button', { name: '切换陪伴角色', exact: true })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(orbit).toBeHidden()
      await expect(page.locator('.companion-page')).toBeFocused()
      await page.keyboard.press('Shift+F10')
      await settledOrbit(page)
      await page.keyboard.press('Shift+Tab')
      await expect(orbit.getByRole('button', { name: '隐藏桌宠', exact: true })).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(orbit.getByRole('button', { name: '收起桌宠菜单', exact: true })).toBeFocused()
      await orbit.getByRole('button', { name: '切换陪伴角色', exact: true }).click()
      await orbit.getByRole('button', { name: '绫地宁宁', exact: true }).click()
      await expect(page.locator('.companion-page')).toHaveAttribute('data-character', 'nene')
      await expect(orbit).toBeHidden()
      await page.keyboard.press('Shift+F10')
      await settledOrbit(page)
      await orbit.getByRole('button', { name: '鼠标穿透', exact: true }).click()
      await expect.poll(() => page.evaluate(() => window.petFixture!.pass)).toBe(true)
      await expect(orbit).toBeHidden()
      await page.keyboard.press('Shift+F10')
      await settledOrbit(page)
      await expect(orbit.getByRole('button', { name: '鼠标穿透', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await orbit.getByRole('button', { name: '鼠标穿透', exact: true }).press('Enter')
      await expect.poll(() => page.evaluate(() => window.petFixture!.pass)).toBe(false)
    })
  test(`orbit preferences tabs return focus and fit ${theme} ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    await desktop(page, theme)
    const before = await page.locator('.live2d-host').boundingBox()
    await page.keyboard.press('Shift+F10')
    const orbit = await settledOrbit(page)
    const settings = orbit.getByRole('button', { name: '设置', exact: true })
    const dialog = page.getByRole('dialog', { name: '桌宠设置', exact: true })
    for (const close of ['button', 'escape']) {
      await settings.click()
      await expect(dialog).toBeVisible()
      await dialog.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))) })
      await expect(dialog.getByRole('button', { name: '关闭桌宠设置', exact: true })).toBeFocused()
      expect(await page.locator('.live2d-host').boundingBox()).toEqual(before)
      await expect(dialog.getByRole('tab', { name: '角色', exact: true })).toHaveAttribute('aria-selected', 'true')
      for (const tab of ['角色', '陪伴', '更多']) {
        await dialog.getByRole('tab', { name: tab, exact: true }).click()
        await expect(dialog.getByRole('tab', { name: tab, exact: true })).toHaveAttribute('aria-selected', 'true')
        if (tab === '角色') await expect(dialog.getByRole('button', { name: '角色取景与外观', exact: true })).toBeVisible()
        if (tab === '陪伴') await expect(dialog.getByRole('slider', { name: '桌宠音量', exact: true })).toBeVisible()
        if (tab === '更多') await expect(dialog.getByRole('button', { name: /AI 工作区/ })).toBeVisible()
        await expect(dialog.getByRole('button', { name: '鼠标穿透', exact: true })).toHaveCount(0)
        await expect(dialog.getByRole('button', { name: '隐藏桌宠', exact: true })).toHaveCount(0)
        for (const label of await dialog.getByRole('tab').all()) {
          await expect(label).toBeInViewport({ ratio: 1 })
          expect(await label.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
        }
        const bounds = await dialog.boundingBox()
        expect(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height).toBeTruthy()
        await page.screenshot({ path: testInfo.outputPath(`preferences-${tab}-${theme}-${viewport.width}.png`) })
      }
      await dialog.getByRole('tab', { name: '更多', exact: true }).press('Home')
      await expect(dialog.getByRole('tab', { name: '角色', exact: true })).toBeFocused()
      await page.keyboard.press('ArrowRight')
      await expect(dialog.getByRole('tab', { name: '陪伴', exact: true })).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('End')
      await expect(dialog.getByRole('tab', { name: '更多', exact: true })).toBeFocused()
      // The content owns scrolling; the title, tabs and close control stay reachable.
      await page.setViewportSize({ width: viewport.width, height: 320 })
      const body = dialog.locator('.companion-preferences-body')
      expect(await body.evaluate(element => ['auto', 'scroll'].includes(getComputedStyle(element).overflowY))).toBe(true)
      await body.evaluate(element => { element.scrollTop = element.scrollHeight })
      await expect(dialog.getByRole('button', { name: '关闭桌宠设置', exact: true })).toBeInViewport({ ratio: 1 })
      await expect(dialog.getByRole('tab', { name: '更多', exact: true })).toBeInViewport({ ratio: 1 })
      if (close === 'button') await dialog.getByRole('button', { name: '关闭桌宠设置', exact: true }).click()
      else await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(settings).toBeFocused()
      await expect(orbit).toBeVisible()
      await page.setViewportSize(viewport)
    }
  })
  }
  test(`wardrobe settings retain shared styling outside chat in ${theme}`, async ({ page }, testInfo) => {
    test.skip(process.env.AICS_LIVE2D_IMPORTS !== '1', 'Requires local Live2D assets')
    test.setTimeout(90000)
    await page.setViewportSize({ width: 540, height: 760 })
    await desktop(page, theme, true)
    await page.goto('/companion?character=nene')
    await expect(page.locator('.live2d-host')).toHaveAttribute('data-state', 'ready', { timeout: 45000 })
    await page.locator('.companion-page').dispatchEvent('contextmenu', { button: 2 })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '角色取景与外观', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '角色取景与外观', exact: true })
    await dialog.locator('button.wardrobe-trigger').click()
    const menu = dialog.locator('.wardrobe-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toHaveCSS('display', 'grid')
    await expect(dialog.locator('.wardrobe-trigger')).toHaveCSS('display', 'flex')
    await expect(dialog.locator('.wardrobe-symbol svg path').first()).toBeVisible()
    await expect(dialog.locator('svg.wardrobe-chevron')).toBeVisible()
    await dialog.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))) })
    for (const width of [540, 360]) {
      await page.setViewportSize({ width, height: 760 })
      const panel = dialog.locator('.character-controls-panel')
      expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      for (const label of await dialog.locator('.stage-framing label').all()) {
        expect(await label.evaluate(el => {
          const range = document.createRange(); range.selectNodeContents(el.firstChild!)
          return range.getClientRects().length
        })).toBe(1)
      }
      for (const selector of ['.wardrobe-copy strong', '.wardrobe-menu-title', '.wardrobe-option.active', '.stage-framing legend']) {
        expect(await dialog.locator(selector).evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
      }
      await page.screenshot({ path: testInfo.outputPath(`wardrobe-${theme}-${width}.png`) })
    }
    await dialog.locator('.wardrobe-option').first().focus()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(dialog.locator('.wardrobe-trigger')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
  test(`pet character settings fit the window and can always close ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 480 })
    await desktop(page, theme)
    await page.locator('.companion-page').dispatchEvent('contextmenu', { button: 2 })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '角色取景与外观', exact: true }).click()
    const panel = page.locator('.character-controls-panel')
    await expect(panel).toBeVisible()
    const dialog = page.getByRole('dialog', { name: '角色取景与外观', exact: true })
    await expect(dialog).toBeVisible()
    await dialog.locator('.character-about > summary').click()
    await dialog.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))) })
    for (const selector of ['h2', '.character-description', '.live2d-quality-control']) {
      expect(await dialog.locator(selector).evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
    }
    await page.screenshot({ path: testInfo.outputPath(`character-settings-${theme}.png`) })
    const bounds = await panel.boundingBox()
    expect(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 360 && bounds.y + bounds.height <= 480).toBeTruthy()
    await page.getByRole('button', { name: '关闭角色设置', exact: true }).click()
    await expect(panel).toBeHidden()
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeFocused()
    for (const mode of ['escape', 'backdrop']) {
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await page.getByRole('button', { name: '角色取景与外观', exact: true }).click()
      await expect(dialog).toBeVisible()
      // Resizing an already-open window must leave a scrollable body and an accessible close button.
      await page.setViewportSize({ width: 360, height: 320 })
      await expect(page.getByRole('button', { name: '关闭角色设置', exact: true })).toBeInViewport()
      const quality = dialog.getByRole('radiogroup', { name: 'Live2D 画质', exact: true })
      await quality.scrollIntoViewIfNeeded()
      await expect(quality).toBeInViewport()
      expect(await panel.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
      await expect(page.getByRole('button', { name: '关闭角色设置', exact: true })).toBeInViewport()
      await quality.getByRole('radio', { name: /标准/ }).click()
      await expect(quality).toHaveAttribute('data-value', 'standard')
      if (mode === 'escape') { await quality.getByRole('radio', { checked: true }).focus(); await page.keyboard.press('Escape') }
      else await page.mouse.click(2, 2)
      await expect(dialog).toBeHidden()
      await page.setViewportSize({ width: 360, height: 480 })
    }
  })
  test(`room character settings still expand and close ${theme}`, async ({ page }) => {
    await desktop(page, theme)
    await page.goto('/chat?character=natsume')
    const summary = page.locator('.character-controls > summary')
    await summary.click()
    const panel = page.locator('.character-controls-panel')
    await expect(panel).toBeVisible()
    await panel.getByRole('radiogroup', { name: 'Live2D 画质' }).getByRole('radio', { checked: true }).focus()
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
    await expect(summary).toBeFocused()
  })
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
    await page.locator('.companion-chat-drag').dispatchEvent('mousedown', { button: 0 })
    await expect.poll(() => page.evaluate(() => window.petFixture!.drag)).toBe(1)
    await expect.poll(() => page.evaluate(() => window.petFixture!.docked)).toBe(false)
    await expect(page.getByRole('button', { name: '贴靠桌宠', exact: true })).toBeVisible()
    await expect(input).toHaveValue('这段草稿暂时不发送')
    await page.getByRole('button', { name: '关闭聊天窗', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.petFixture!.closeChat)).toBe(1)
  })
  test(`pet stays transparent before application mount ${theme}`, async ({ page }) => {
    await page.addInitScript(theme => { localStorage.setItem('aics_theme', theme); Object.assign(window, { desktopCapabilitiesFixture: { isDesktop: true } }) }, theme)
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
    await expect(page.locator('[data-tauri-drag-region]')).toBeHidden()
    await expect(page.locator('.companion-chat-chip')).toBeHidden()
    await expect(page.locator('.portrait-main')).toBeHidden()
    await page.mouse.move(10, 110)
    await expect(page.locator('.companion-page')).toHaveAttribute('data-ui-hidden', 'true', { timeout: 8000 })
    await expect(page.locator('.companion-toolbar')).toBeHidden()
    await page.screenshot({ path: testInfo.outputPath(`pet-quiet-${theme}.png`), omitBackground: true })
    await page.mouse.move(240, 360)
    await expect(page.locator('.companion-toolbar')).toBeHidden()
    await page.locator('.companion-page').dispatchEvent('contextmenu', { button: 2 })
    await page.getByRole('region', { name: '桌宠环形菜单', exact: true }).getByRole('button', { name: '鼠标穿透', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.petFixture!.pass)).toBe(true)
    await expect(page.locator('.companion-orbit')).toBeHidden()
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('aics_companion_chat_live_v1') || '{}').chatReady)).toBe(true)
    await page.evaluate(() => window.petFixture!.send({ command: 'send', character: 'natsume', text: '气泡测试' }))
    await expect(page.locator('.companion-reply-preview')).toContainText('我就在这里')
    await expect(page.locator('.companion-reply-preview')).toHaveCSS('opacity', '1')
    const stage = await page.locator('.live2d-host').boundingBox()
    await page.screenshot({ path: testInfo.outputPath(`pet-reply-${theme}.png`), omitBackground: true })
    await page.getByRole('button', { name: '展开完整回复', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.petFixture!.open)).toBe(1)
    await page.getByRole('button', { name: '收起回复气泡', exact: true }).click()
    await expect(page.locator('.companion-reply-preview')).toHaveCount(0)
    expect(await page.locator('.live2d-host').boundingBox()).toEqual(stage)
    await page.mouse.move(250, 370)
    await page.locator('.companion-page').dispatchEvent('contextmenu', { button: 2 })
    await page.getByRole('button', { name: '隐藏桌宠', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.petFixture!.hide)).toBe(1)
    await page.setViewportSize({ width: 360, height: 520 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.locator('.companion-orbit')).toBeHidden()
    await page.keyboard.press('Shift+F10')
    await settledOrbit(page)
    await expect(page.getByRole('button', { name: '隐藏桌宠', exact: true })).toBeInViewport()
  })

  test(`orbit real built-in models and authored head interaction ${theme}`, async ({ page }, testInfo) => {
    test.skip(process.env.AICS_LIVE2D_IMPORTS !== '1', 'Requires private local assets')
    test.setTimeout(120000)
    await page.setViewportSize({ width: 540, height: 760 })
    await desktop(page, theme, true)
    for (const id of ['natsume', 'nene']) {
      const host = page.locator('.live2d-host')
      if (id === 'nene') {
        await page.keyboard.press('Shift+F10')
        const menu = await settledOrbit(page)
        await menu.getByRole('button', { name: '切换陪伴角色', exact: true }).click()
        await menu.locator(`button[data-value="${id}"]`).click()
      }
      await expect(page.locator('.companion-page')).toHaveAttribute('data-character', id)
      await expect(host).toHaveAttribute('data-state', 'ready', { timeout: 45000 })
      await expect(host.locator('canvas')).toBeVisible()
      const frame = await host.boundingBox()
      await page.keyboard.press('Shift+F10')
      const menu = await settledOrbit(page)
      await page.screenshot({ path: testInfo.outputPath(`orbit-real-${id}-${theme}.png`), omitBackground: true })
      await menu.getByRole('button', { name: '互动动作', exact: true }).click()
      const head = menu.locator('button[data-value="Head"]')
      await expect(head).toBeEnabled()
      await page.locator('.portrait-stage').evaluate(element => {
        element.classList.remove('live2d-reacting')
        element.removeAttribute('data-test-motion-started')
        // Vue can reconcile the class immediately after the real motion callback.
        // Latch its observed transition instead of depending on poll timing.
        const observer = new MutationObserver(records => {
          if (element.classList.contains('live2d-reacting') || records.some(record => record.oldValue?.includes('live2d-reacting'))) {
            element.setAttribute('data-test-motion-started', 'true')
            observer.disconnect()
          }
        })
        observer.observe(element, { attributes: true, attributeFilter: ['class'], attributeOldValue: true })
      })
      await head.click()
      // This class is set only after the actual model motion reports it started.
      await expect(page.locator('.portrait-stage')).toHaveAttribute('data-test-motion-started', 'true', { timeout: 15000 })
      await expect(menu.locator('.orbit-feedback')).not.toBeEmpty()
      await expect(menu.locator('.orbit-feedback')).not.toContainText(/尚未解锁|没有启动|暂时不可用/)
      expect(await host.boundingBox()).toEqual(frame)
      await page.screenshot({ path: testInfo.outputPath(`orbit-real-${id}-head-${theme}.png`), omitBackground: true })
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await expect(menu).toBeHidden()
    }
  })

  test(`frameless pet real models and transparent corners ${theme}`, async ({ page }, testInfo) => {
    test.skip(process.env.AICS_LIVE2D_IMPORTS !== '1', 'Requires private local assets')
    test.setTimeout(150000)
    await page.setViewportSize({ width: 480, height: 720 })
    await desktop(page, theme, true)
    for (const id of ['natsume', 'hatsune_miku', 'frieren']) {
      await page.mouse.move(20, 110)
      await page.locator('.companion-page').dispatchEvent('contextmenu', { button: 2 })
      await page.getByRole('button', { name: '切换陪伴角色', exact: true }).click()
      await page.locator(`.companion-orbit button[data-value="${id}"]`).click()
      await expect(page.locator('.companion-orbit')).toBeHidden()
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

test.beforeEach(async ({ page }) => { await installDesktopHostFixture(page) })

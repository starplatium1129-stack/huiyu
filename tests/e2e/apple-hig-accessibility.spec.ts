import { expect, test, type Page } from '@playwright/test'
import { textContrast } from './helpers/contrast'

const appearanceKey = 'atelier-desktop-appearance-v1'

async function openAppearance(page: Page) {
  const toggle = page.locator('.nav-menu-toggle')
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  await page.locator('.nav-more > summary').click()
  await page.getByRole('button', { name: '外观与动态效果', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '外观与动态效果', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

for (const theme of ['dark', 'light'] as const) {
  test(`native modal keeps keyboard control above an existing story drawer ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.goto('/scene-explorer')
    const trigger = page.getByRole('button', { name: '故事', exact: true }).first()
    await trigger.click()
    const drawer = page.getByRole('dialog', { name: '场景故事', exact: true })
    const close = drawer.getByRole('button', { name: '关闭故事', exact: true })
    await expect(close).toBeFocused()
    // Exercise the browser's real top layer, both outside and inside the custom trap.
    for (const nested of [false, true]) {
      await page.evaluate(nested => {
        const native = document.createElement('dialog')
        native.id = 'native-focus-regression'
        native.setAttribute('aria-label', '原生弹窗验证')
        native.innerHTML = '<button>第一项</button><button>第二项</button>'
        ;(nested ? document.querySelector('.story-card')! : document.body).append(native)
        native.showModal()
      }, nested)
      const native = page.locator('#native-focus-regression')
      await expect(native.getByRole('button', { name: '第一项' })).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(native.getByRole('button', { name: '第二项' })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(native).toBeHidden()
      await expect(drawer).toBeVisible()
      await expect(close).toBeFocused()
      await native.evaluate(element => element.remove())
    }
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await expect(trigger).toBeFocused()
  })

  test(`destructive confirmation defaults to cancel and restores the selected works ${theme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.addInitScript(() => localStorage.setItem('aics_pb_history', JSON.stringify([
      { id: 'hig-first', sceneTitle: '键盘验证作品一', prompt: 'focus fixture' },
      { id: 'hig-second', sceneTitle: '键盘验证作品二', prompt: 'focus fixture' },
    ])))
    await page.goto('/gallery')
    await page.getByRole('button', { name: '选择', exact: true }).click()
    await page.getByRole('button', { name: /全选/ }).click()
    const trigger = page.getByRole('button', { name: '移入回收站（2）', exact: true })
    await trigger.click()
    const dialog = page.getByRole('alertdialog')
    const cancel = dialog.getByRole('button', { name: '取消', exact: true })
    await expect(cancel).toBeFocused()
    await expect(dialog).toHaveAccessibleDescription(/.+/)
    expect(await dialog.locator('.confirm-message').evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
    await page.keyboard.press('Enter')
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()
    await expect(page.locator('.gallery-bulk-count')).toContainText('已选 2 / 2')
    await trigger.click()
    await page.keyboard.press('Shift+Tab')
    await expect(dialog.getByRole('button', { name: '移入回收站', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(cancel).toBeFocused()
    await page.screenshot({ path: testInfo.outputPath(`confirmation-${theme}.png`) })
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()
    await expect(page.locator('.artwork')).toHaveCount(2)
  })

  test(`system material preferences update open surfaces without changing the saved choice ${theme}`, async ({ page }, testInfo) => {
    const media = await page.context().newCDPSession(page)
    const setMedia = (transparency: boolean, contrast = false, forcedColors = false) => media.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: theme },
        { name: 'prefers-reduced-motion', value: 'reduce' },
        { name: 'prefers-reduced-transparency', value: transparency ? 'reduce' : 'no-preference' },
        { name: 'prefers-contrast', value: contrast ? 'more' : 'no-preference' },
        { name: 'forced-colors', value: forcedColors ? 'active' : 'none' },
      ],
    })
    await setMedia(true)
    await page.goto('/gallery')
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    const dialog = await openAppearance(page)
    const savedGlass = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)!).reducedGlass, appearanceKey)
    const blur = () => dialog.evaluate(element => getComputedStyle(element, '::backdrop').backdropFilter)
    const assertSolid = async () => {
      await expect(page.locator('html')).toHaveAttribute('data-reduced-glass', 'true')
      await expect.poll(blur).toBe('none')
      await expect.poll(() => page.locator('.nav').evaluate(element => getComputedStyle(element).backdropFilter)).toBe('none')
      await expect(dialog.getByLabel('降低玻璃效果')).not.toBeChecked()
      expect(await savedGlass()).toBe(false)
    }
    await assertSolid()
    expect(await dialog.locator('.appearance-note').evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
    await page.screenshot({ path: testInfo.outputPath(`materials-${theme}.png`), fullPage: true })

    await setMedia(false)
    await expect(page.locator('html')).toHaveAttribute('data-reduced-glass', 'false')
    await expect.poll(blur).not.toBe('none')
    await setMedia(false, true)
    await assertSolid()
    await setMedia(false, false, true)
    await assertSolid()
    await setMedia(false)
    await dialog.getByLabel('降低玻璃效果').check()
    await setMedia(true)
    await setMedia(false)
    await expect(page.locator('html')).toHaveAttribute('data-reduced-glass', 'true')
    await expect.poll(blur).toBe('none')
    expect(await savedGlass()).toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(page.locator('.nav-more > summary')).toBeFocused()
    await media.detach()
  })
}

test.describe('touch and text resizing', () => {
  test.use({ hasTouch: true, isMobile: true })

  for (const theme of ['dark', 'light'] as const) {
    test(`navigation has separate touch targets and retains its text size at 320px ${theme}`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await page.setViewportSize({ width: 1440, height: 960 })
      await page.goto('/gallery')
      const desktopFont = await page.locator('html').evaluate(element => getComputedStyle(element).fontSize)
      await page.setViewportSize({ width: 320, height: 640 })
      await expect(page.locator('html')).toHaveCSS('font-size', desktopFont)
      await page.locator('.nav-menu-toggle').click()
      const controls = page.locator('.nav').locator('button:visible, summary:visible, a:not(.nav-brand):visible')
      const boxes = await controls.evaluateAll(elements => elements.map(element => {
        const box = element.getBoundingClientRect()
        return { label: element.getAttribute('aria-label') || element.textContent, x: box.x, y: box.y, width: box.width, height: box.height }
      }))
      for (const box of boxes) {
        expect(box.width, `${box.label} width`).toBeGreaterThanOrEqual(44)
        expect(box.height, `${box.label} height`).toBeGreaterThanOrEqual(44)
      }
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!, b = boxes[j]!
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
        expect(overlapX <= 0.5 || overlapY <= 0.5, `${a.label} overlaps ${b.label}`).toBe(true)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'touch media before screenshot').toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`touch-navigation-${theme}.png`) })
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'touch media after screenshot').toBe(true)

      const dialog = await openAppearance(page)
      await page.locator('html').evaluate((element, font) => {
        element.style.fontSize = `${parseFloat(font) * 2}px`
      }, desktopFont)
      await expect(dialog.getByLabel('画室主题')).toBeVisible()
      await dialog.getByLabel('动态效果').selectOption('reduce')
      const close = dialog.getByRole('button', { name: '关闭', exact: true })
      await close.scrollIntoViewIfNeeded()
      expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      const box = (await close.boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(44)
      expect(box.height).toBeGreaterThanOrEqual(44)
      await page.screenshot({ path: testInfo.outputPath(`text-resize-${theme}.png`) })
      await close.click()
      await expect(dialog).toBeHidden()
    })

    for (const route of ['/', '/scene-explorer', '/prompt-builder', '/gallery']) {
      test(`primary content reflows at 320px ${theme} ${route}`, async ({ page }) => {
        await page.setViewportSize({ width: 320, height: 640 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
        await page.goto(route)
        await expect(page.locator('h1').first()).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      })
    }
  }
})

import { test, expect, type Locator, type Page } from '@playwright/test'
import { textContrast } from './helpers/contrast'
import { onArtTextContrast } from './helpers/ui-fluidity-office'
import { installSceneStateFixture } from './helpers/sceneState'

const base = process.env.AICS_UI_AUDIT_URL || ''

async function open(page: Page, route: string, theme: string, width: number, height = 640) {
  await page.setViewportSize({ width, height })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
  if (route === '/scene-manager') await installSceneStateFixture(page)
  await page.goto(base + route, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('h1').first()).toBeVisible()
}

async function contrast(locator: Locator, pseudo: string | null = null) {
  await locator.evaluate(async element => {
    const animations: Animation[] = []
    for (let node: Element | null = element; node; node = node.parentElement) {
      animations.push(...node.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity))
    }
    await Promise.all(animations.map(animation => animation.finished.catch(() => {})))
  })
  return locator.evaluate(textContrast, pseudo)
}

test('contrast audit includes text alpha and nested group opacity', async ({ page }) => {
  await page.setContent(`<style>html, body { margin: 0; background: white }</style>
    <span id="opaque" style="color: black">Text</span>
    <span id="faded" style="color: black; opacity: .5">Text</span>
    <span id="alpha" style="color: rgba(0, 0, 0, .5)">Text</span>
    <div style="background: black"><div style="background: white; opacity: .5">
      <span id="group" style="color: black">Text</span>
      <span id="nested" style="color: black; opacity: .5">Text</span>
    </div></div>
    <div class="art-viewer" style="background: white"><span id="on-light" style="color: black">Text</span></div>
    <div class="art-viewer" style="background: black"><span id="on-dark" style="color: white">Text</span></div>`)
  expect(await contrast(page.locator('#opaque'))).toBeCloseTo(21, 2)
  expect(await contrast(page.locator('#faded'))).toBeCloseTo(3.977, 2)
  expect(await contrast(page.locator('#alpha'))).toBeCloseTo(4.004, 2)
  expect(await contrast(page.locator('#group'))).toBeCloseTo(5.281, 2)
  expect(await contrast(page.locator('#nested'))).toBeCloseTo(2.617, 2)
  expect(await page.locator('#on-light').evaluate(onArtTextContrast)).toBeCloseTo(21, 2)
  expect(await page.locator('#on-dark').evaluate(onArtTextContrast)).toBeCloseTo(21, 2)
})

for (const theme of ['dark', 'light']) {
  test(`inspiration search uses the available desktop width ${theme}`, async ({ page }) => {
    await open(page, '/scene-explorer', theme, 1320, 800)
    for (const width of [1320, 1280, 960]) {
      await page.setViewportSize({ width, height: 800 })
      const toolbar = (await page.locator('.scene-toolbar').boundingBox())!
      const search = (await page.locator('.toolbar-primary').boundingBox())!
      const inset = await page.locator('.scene-toolbar').evaluate(element => {
        const style = getComputedStyle(element)
        return ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((sum, key) => sum + parseFloat(style[key as keyof CSSStyleDeclaration] as string), 0)
      })
      if (width <= 1300) expect(search.width).toBeGreaterThanOrEqual(toolbar.width - inset - 2)
      else expect(search.width).toBeGreaterThan(toolbar.width / 2)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    }
  })
  test(`popular scene count labels retain AA contrast ${theme}`, async ({ page }) => {
    await open(page, '/popular-scenes', theme, 1440)
    await expect(page.locator('.pop-cat').first()).toBeVisible()
    for (const count of await page.locator('.pop-cat:not(.active) em').all()) {
      expect(await contrast(count)).toBeGreaterThanOrEqual(4.5)
    }
  })

  for (const width of [1024]) {
    test(`material and inspector do not overlap ${theme} ${width}`, async ({ page }) => {
      await open(page, '/prompt-builder', theme, width)
      await expect(page.locator('#drawing-materials')).toBeVisible()
      await expect(page.locator('.director-inspector')).toBeVisible()
      await page.locator('.trait-chip').first().click({ trial: true })
      await page.getByRole('button', { name: '专家模式', exact: true }).click()
      await page.locator('#inspector-tab-prompt').click()
      await expect(page.locator('#drawing-materials')).toBeVisible()
      await expect(page.locator('.director-inspector')).toBeVisible()
      await expect(page.locator('#promptMonitor')).toBeVisible()
      const canvas = (await page.locator('#drawing-canvas').boundingBox())!
      const material = (await page.locator('#drawing-materials').boundingBox())!
      const inspector = (await page.locator('.director-inspector').boundingBox())!
      expect(material.x + material.width).toBeLessThanOrEqual(canvas.x + 1)
      expect(canvas.x + canvas.width).toBeLessThanOrEqual(inspector.x + 1)
      await expect(page.getByRole('button', { name: '生成图片', exact: true })).toBeInViewport({ ratio: 1 })
    })
  }

  test(`toast remains dismissible without covering startup ${theme}`, async ({ page }) => {
    await open(page, '/prompt-builder', theme, 1024)
    await expect(page.locator('.api-status .badge')).toBeVisible()
    await page.waitForTimeout(900)
    await expect(page.locator('.toast-item')).toHaveCount(0)
    await page.getByRole('button', { name: '专家模式', exact: true }).click()
    await page.locator('.engine-switch button').nth(2).click()
    await expect(page.locator('.toast-item')).toHaveCount(1)
    await page.locator('.toast-close').click()
    await expect(page.locator('.toast-item')).toHaveCount(0)
  })

  test(`message actions retain AA contrast without hover ${theme}`, async ({ page }) => {
    await open(page, '/chat', theme, 1024)
    await page.evaluate(() => {
      const host = document.createElement('div')
      host.className = 'message user'
      host.innerHTML = '<div class="message-body"><div class="message-bubble">Fixture</div><div class="message-meta"><button class="msg-memory-btn" type="button">Copy</button><button class="msg-memory-btn remembered" type="button" disabled>Remembered</button></div></div>'
      document.querySelector('.conversation-card')?.append(host)
    })
    const action = page.locator('.message .msg-memory-btn:not(.remembered)').last()
    await expect(action).toBeVisible()
    expect(await contrast(action)).toBeGreaterThanOrEqual(4.5)
    const remembered = page.locator('.message .msg-memory-btn.remembered').last()
    expect(await contrast(remembered)).toBeGreaterThanOrEqual(4.5)
  })

  test(`rating badges retain AA contrast ${theme}`, async ({ page }) => {
    await open(page, '/scene-explorer', theme, 1440)
    await expect(page.locator('.sc').first()).toBeVisible()
    // Test the actual shared badge rules independently of the current filter pool.
    await page.evaluate(() => {
      const host = document.createElement('div'); host.className = 'sc'; host.id = 'rating-audit'
      host.innerHTML = '<span class="sc-badge sc-rating r15">R15</span><span class="sc-badge sc-rating r18">R18</span>'
      document.body.append(host)
    })
    expect(await contrast(page.locator('#rating-audit .r15'))).toBeGreaterThanOrEqual(4.5)
    expect(await contrast(page.locator('#rating-audit .r18'))).toBeGreaterThanOrEqual(4.5)
  })

  test(`companion settings are above portrait controls ${theme}`, async ({ page }) => {
    await open(page, '/companion', theme, 390)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const popover = page.locator('.companion-settings-popover')
    await expect(popover).toBeVisible()
    await popover.locator('button, [role="switch"]').first().click({ trial: true })
    expect(await contrast(page.locator('.companion-input'))).toBeGreaterThanOrEqual(4.5)
    expect(await contrast(page.locator('.companion-send'))).toBeGreaterThanOrEqual(4.5)
    await expect(popover.getByText('完整房间（聊天）', { exact: true })).toHaveCount(1)
    await popover.getByRole('button', { name: '打开完整工作台', exact: true }).click()
    await expect(page).toHaveURL(/\/prompt-builder$/)
  })

  test(`inpaint controls remain readable and reachable ${theme}`, async ({ page }) => {
    await open(page, '/prompt-builder', theme, 1024)
    await page.getByRole('tab', { name: '成片', exact: true }).click()
    await page.getByRole('button', { name: '导入图片换装', exact: true }).click()
    const modal = page.getByRole('dialog', { name: '智能局部换装', exact: true })
    await expect(modal).toBeVisible()
    expect(await contrast(modal.locator('.dropzone-hint'))).toBeGreaterThanOrEqual(4.5)
    const maskModes = modal.getByRole('group', { name: '遮罩模式', exact: true })
    const paintMask = maskModes.getByRole('button', { name: '手绘精确遮罩' })
    const autoMask = maskModes.getByRole('button', { name: '自动识别' })
    await expect(autoMask).toHaveAttribute('aria-pressed', 'true')
    await expect(paintMask).toHaveAttribute('aria-pressed', 'false')
    await expect(modal.getByRole('group', { name: '目标服装形态' }).getByRole('button').first()).toBeVisible()
    await expect(modal.getByRole('slider', { name: '重绘去噪幅度' })).toBeVisible()
    await expect(modal.getByRole('slider', { name: '遮罩边缘羽化外扩' })).toBeVisible()
    await paintMask.click()
    await expect(paintMask).toHaveAttribute('aria-pressed', 'true')
    expect(await contrast(paintMask)).toBeGreaterThanOrEqual(4.5)
    expect(await contrast(modal.locator('.prompt-textarea').first(), '::placeholder')).toBeGreaterThanOrEqual(4.5)
    await modal.locator('.preset-card:not(.is-nsfw)').first().click()
    expect(await contrast(modal.locator('.preset-card.active'))).toBeGreaterThanOrEqual(4.5)
    await modal.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(modal).not.toBeVisible()
  })
}

// Large character libraries and narrow inspector columns must remain browsable.
for (const theme of ['dark', 'light']) {
  for (const width of [1440, 1280]) {
    test(`drawing sidebars catalog and readable cards ${theme} ${width}`, async ({ page }, testInfo) => {
      await open(page, '/prompt-builder', theme, width, 900)
      await page.getByRole('button', { name: '专家模式', exact: true }).click()
      await page.getByRole('button', { name: '热门角色 · 无需 LoRA', exact: true }).click()
      const trigger = page.getByRole('button', { name: /浏览全部 .* 位角色/ })
      await expect(trigger).toContainText(/浏览全部 [1-9]\d* 位角色/)
      await trigger.click()
      const dialog = page.locator('.character-browser-dialog')
      await expect(dialog).toBeVisible()
      await expect(dialog).toHaveCSS('opacity', '1')
      await expect(dialog.locator('.directory-item')).toHaveCount(18)
      await dialog.screenshot({ path: testInfo.outputPath(`character-catalog-${theme}-${width}.png`) })
      const firstId = await dialog.locator('.directory-item').first().getAttribute('data-character')
      await dialog.getByRole('button', { name: '下一页', exact: true }).click()
      expect(await dialog.locator('.directory-item').first().getAttribute('data-character')).not.toBe(firstId)
      await dialog.getByRole('button', { name: /^原神 / }).click()
      await expect(dialog.locator('.directory-item')).toHaveCount(4)
      await dialog.locator('.directory-item').filter({ hasText: '芙宁娜' }).click()
      await expect(dialog).not.toBeVisible()
      await expect(page.locator('.character-browse-trigger')).toContainText('芙宁娜')
      await page.locator('.popular-picker').screenshot({ path: testInfo.outputPath(`character-picker-${theme}-${width}.png`) })
      await expect(trigger).toBeFocused()
      await trigger.click()
      await page.keyboard.press('Escape')
      await expect(dialog).not.toBeVisible()
      await page.getByRole('tab', { name: '画面', exact: true }).click()
      await page.getByTestId('artist-style-picker').locator('summary').click()
      await page.getByLabel('搜索画师或作品', { exact: true }).fill('米山舞')
      const artist = page.locator('.artist-style-grid button').first()
      await expect(artist).toBeVisible()
      expect((await artist.boundingBox())!.width).toBeGreaterThan(180)
      expect(await artist.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
      await page.getByLabel('搜索画师或作品', { exact: true }).fill('ask_(askzy)')
      await page.locator('[data-artist-style-id="ask_(askzy)"]').click()
      const artistTokens = page.locator('.artist-style-tokens code')
      await expect(artistTokens).toHaveText(String.raw`@ask \(askzy\)`)
      await expect(page.locator('.toast-item')).toHaveCount(0)
      await artistTokens.scrollIntoViewIfNeeded()
      expect(await artistTokens.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
      expect(await contrast(artistTokens)).toBeGreaterThanOrEqual(4.5)
      await expect(artistTokens).toBeVisible()
      await artistTokens.locator('..').screenshot({ path: `.review-shots/artist-tag-${theme}-${width}.png` })
      await page.screenshot({ path: `.review-shots/drawing-sidebar-${theme}-${width}.png`, fullPage: true })
      await page.getByRole('tab', { name: '提示词', exact: true }).click()
      const tag = page.locator('.tag-results button').first()
      await expect(tag).toBeVisible()
      expect((await tag.boundingBox())!.width).toBeGreaterThan(125)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      await trigger.click()
      const bounds = (await dialog.boundingBox())!
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
      expect(bounds.y).toBeGreaterThanOrEqual(0)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(901)
      expect(await contrast(dialog.locator('.directory-label strong').first())).toBeGreaterThanOrEqual(4.5)
      await page.screenshot({ path: `.review-shots/drawing-catalog-${theme}-${width}.png` })
    })
  }
}

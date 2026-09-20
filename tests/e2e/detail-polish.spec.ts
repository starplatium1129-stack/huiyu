import { expect, test } from '@playwright/test'
import { installShowcaseFixture } from './helpers/showcase'

for (const theme of ['dark', 'light']) {
  test(`offline video remains editable and script dialog works on a narrow screen ${theme}`, async ({ page }) => {
    await page.addInitScript(t => localStorage.setItem('aics_theme', t), theme)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.route('**/api/video/status', route => route.fulfill({ json: {
      ok: true, online: false, pending: 0, maxPending: 2,
      models: [{ id: 'minimax-h3', label: 'MiniMax H3', available: true, executable: true, modes: ['text', 'image', 'first-last-frame'], requirements: [], missing: [] }],
      qualities: [], defaults: { modelId: 'minimax-h3' }, t8: { available: false, reason: '提交任务时会自动重新探测' },
    } }))
    await page.goto('/video-studio')
    const mode = page.getByRole('button', { name: /分镜短片/ })
    await expect(mode).toContainText('离线 · 可编辑')
    await mode.click()
    const opener = page.getByRole('button', { name: 'AI 生成脚本', exact: true })
    await opener.click()
    const dialog = page.getByRole('dialog', { name: 'AI 生成分镜脚本' })
    await expect(dialog.getByRole('textbox')).toBeFocused()
    const box = await dialog.boundingBox()
    expect(box!.height).toBeLessThanOrEqual(844)
    await page.screenshot({ path: `runtime/detail-polish-script-${theme}.png` })
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(opener).toBeFocused()
  })

  test(`portrait captions stay readable over artwork ${theme}`, async ({ page }) => {
    await page.addInitScript(t => localStorage.setItem('aics_theme', t), theme)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/chat')
    const caption = page.locator('.room-signal')
    await expect(caption).toBeVisible()
    const contrast = await caption.evaluate(el => {
      const ctx = document.createElement('canvas').getContext('2d')!
      const rgba = (color: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data] }
      const light = (color: number[]) => color.slice(0, 3).map(v => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4 }).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0)
      const bg = rgba(getComputedStyle(el).backgroundColor)
      return { alpha: bg[3], ratios: [...el.querySelectorAll('span,small')].map(node => { const a = light(bg), b = light(rgba(getComputedStyle(node).color)); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05) }) }
    })
    expect(contrast.alpha).toBe(255)
    expect(Math.min(...contrast.ratios)).toBeGreaterThanOrEqual(4.5)
  })

  test(`search respects IME and restores its opener ${theme}`, async ({ page }) => {
    await page.addInitScript(t => localStorage.setItem('aics_theme', t), theme)
    await page.goto('/')
    const opener = page.getByRole('button', { name: '搜索页面、场景与作品', exact: true })
    await opener.click()
    const search = page.getByRole('dialog', { name: '全局搜索' })
    const input = search.getByRole('searchbox')
    await input.fill('绘制')
    await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
    await expect(search).toBeVisible()
    await expect(page).toHaveURL(/\/$/)
    await input.dispatchEvent('keydown', { key: 'Escape', isComposing: true })
    await expect(search).toBeVisible()
    await search.getByRole('button', { name: '关闭搜索' }).click()
    await expect(search).toBeHidden()
    await expect(opener).toBeFocused()
  })

  test(`navigation closes one level and restores keyboard focus ${theme}`, async ({ page }) => {
    await page.addInitScript(t => localStorage.setItem('aics_theme', t), theme)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    const toggle = page.locator('.nav-menu-toggle')
    await toggle.click()
    await expect(page.locator('.nav-links > a').first()).toBeFocused()
    const more = page.locator('.nav-more-trigger')
    await more.click()
    await page.getByRole('link', { name: '我的作品', exact: true }).focus()
    await page.keyboard.press('Escape')
    await expect(more).toBeFocused()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toBeFocused()
    await toggle.click()
    const menu = await page.locator('.nav-links').boundingBox()
    await page.mouse.click(Math.max(1, menu!.x - 8), menu!.y + menu!.height / 2)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })
}

test('showcase distinguishes an empty catalog from a filter miss and keeps search focus', async ({ page }) => {
  await page.route('**/scene-showcase/manifest.json', route => route.fulfill({ json: { entries: [] } }))
  await page.goto('/showcase')
  await expect(page.locator('.archive-state-panel[data-kind="empty"]')).toBeVisible()
  const random = page.getByRole('button', { name: '随机邂逅一张' })
  await expect(random).toBeDisabled()
  await installShowcaseFixture(page)
  await page.getByRole('button', { name: '刷新画册' }).click()
  const input = page.getByRole('searchbox', { name: '搜索画册' })
  await input.fill('不存在的场景')
  await expect(page.locator('.archive-state-panel[data-kind="filtered"]')).toBeVisible()
  await expect(random).toBeDisabled()
  await page.getByRole('button', { name: '清空搜索', exact: true }).click()
  await expect(input).toBeFocused()
  await expect(random).toBeEnabled()
})

test('selection follows selected control resizing and keeps rapid reversals aligned', async ({ page }) => {
  await page.goto('/')
  const group = page.getByRole('group', { name: '首页角色视觉' })
  await group.evaluate(el => { el.style.width = '600px' })
  const selected = group.getByRole('button', { name: '绫地宁宁' })
  await selected.evaluate(el => { el.style.width = '240px' })
  const aligned = () => group.evaluate(el => {
    const a = el.querySelector('[aria-pressed="true"]')!.getBoundingClientRect()
    const b = el.querySelector('.animated-selection')!.getBoundingClientRect()
    return Math.abs(a.x - b.x) + Math.abs(a.width - b.width)
  })
  await expect.poll(aligned).toBeLessThan(2)
  await group.getByRole('button', { name: '四季夏目' }).click()
  await selected.click()
  await expect.poll(aligned).toBeLessThan(2)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await group.getByRole('button', { name: '四季夏目' }).click()
  await expect.poll(aligned).toBeLessThan(2)
  expect(await group.locator('.animated-selection').evaluate(el => el.getAnimations().filter(a => a.playState === 'running').length)).toBe(0)
})

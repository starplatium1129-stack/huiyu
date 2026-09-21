import { test, expect, type Page } from '@playwright/test'
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const fixtureDir = path.resolve('runtime/model-studio-review/neutral-model')
test.beforeAll(() => {
  mkdirSync(fixtureDir, { recursive: true })
  writeFileSync(path.join(fixtureDir, 'neutral.model3.json'), JSON.stringify({ Version: 3, FileReferences: { Moc: 'neutral.moc3', Textures: ['texture.png'] }, Groups: [{ Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] }] }))
  writeFileSync(path.join(fixtureDir, 'neutral.moc3'), Buffer.from('MOC3\x03\x00\x00\x00'))
  writeFileSync(path.join(fixtureDir, 'texture.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'))
})

async function openStudio(page: Page, theme: string, mockRuntime = true, companion = false) {
  await page.route('**/api/live2d-companions', route => route.fulfill({ json: [] }))
  await page.addInitScript(({ theme, mockRuntime }) => {
    localStorage.setItem('aics_theme', theme)
    localStorage.setItem('aics_companion_live2d_v1', 'false')
    if (!mockRuntime) return
    let destroyed = 0
    const core = { getModel: () => ({ parameters: { ids: ['ParamMouthOpenY', 'ParamEyeLOpen'], minimumValues: [-1, 0], maximumValues: [2, 1], defaultValues: [0, 1], values: [0, 1] } }), setParameterValueById: () => {}, getParameterValueById: () => 0 }
    Object.assign(window, { __modelDestroyCount: () => destroyed, 'wl-live2d': { wlLive2d: (options: { el: string }) => {
      const canvas = document.createElement('canvas'); canvas.width = 440; canvas.height = 480
      const host = document.querySelector(options.el) || document.querySelector('.model-preview-host')
      host?.append(canvas)
      const model = { visible: true, width: 400, height: 440, x: 0, y: 0, scale: { x: 1, y: 1, set: () => {} }, internalModel: { coreModel: core, on: () => {}, motionManager: { definitions: {}, stopAllMotions: () => {} } }, focus: () => {}, motion: () => true }
      return { app: { screen: { width: 440, height: 480 }, ticker: { started: true, start: () => {}, stop: () => {} } }, onModelLoaded: (callback: (value: unknown) => void) => setTimeout(() => callback(model), 20), onModelError: () => {}, destroy: () => { destroyed++; canvas.remove() } }
    } } })
  }, { theme, mockRuntime })
  await page.goto(companion ? '/companion' : '/chat')
  if (companion) {
    await page.locator('.companion-page').click({ button: 'right', position: { x: 12, y: 12 } })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '角色取景与外观', exact: true }).click()
  }
  await page.getByRole('button', { name: '导入或校准模型' }).click()
  await expect(page.getByRole('dialog', { name: '模型导入与校准' })).toBeVisible()
}

for (const theme of ['dark', 'light']) test(`companion model studio is reachable and restores settings focus ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 720 })
  await openStudio(page, theme, true, true)
  const dialog = page.getByRole('dialog', { name: '模型导入与校准', exact: true })
  await expect(dialog).toBeVisible()
  await page.screenshot({ path: `runtime/model-studio-review/companion-${theme}.png`, animations: 'disabled' })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: '导入或校准模型', exact: true })).toBeFocused()
})

for (const theme of ['dark', 'light']) for (const width of [1440, 390]) {
  test(`model studio ${theme} ${width}: folder, calibrated save, reset and focus`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 })
    await openStudio(page, theme)
    const dialog = page.getByRole('dialog', { name: '模型导入与校准' })
    await dialog.getByLabel('模型文件夹', { exact: true }).setInputFiles(fixtureDir)
    await expect(dialog.getByText('文件检查 · 通过')).toBeVisible()
    await dialog.getByRole('button', { name: '加载预览', exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText('2 个真实参数')
    await dialog.getByLabel('角色 ID', { exact: true }).fill('neutral_fixture')
    await dialog.getByLabel('角色名称', { exact: true }).fill('中性夹具')
    await dialog.getByLabel('独立角色设定').fill('只用于隔离校准测试的中性角色。')
    await dialog.getByLabel('作者或来源').fill('自动化测试夹具')
    await dialog.getByLabel('许可与使用范围').fill('仅隔离测试')
    await dialog.getByRole('combobox', { name: '口型参数', exact: true }).selectOption('ParamMouthOpenY')
    await dialog.getByLabel('口型闭合值', { exact: true }).fill('2')
    await dialog.getByLabel('口型张开值', { exact: true }).fill('-1')
    await dialog.getByLabel('模拟语音电平').fill('0.5')
    let body = ''
    await page.route('**/api/live2d-import', async route => {
      body = route.request().postDataBuffer()?.toString() || ''
      await route.fulfill({ status: 201, json: { id: 'neutral_fixture', revision: 'fixture-revision', fingerprint: 'fixture-fingerprint' } })
    })
    await dialog.getByRole('button', { name: '保存并加入角色列表' }).click()
    await expect(dialog.getByRole('status')).toContainText('已保存')
    expect(body).toContain('"closed":2,"open":-1')
    expect(body).toContain('needs-confirmation')
    await dialog.evaluate(el => { el.querySelector('.model-studio-scroll')!.scrollTop = 0 })
    await page.screenshot({ path: `runtime/model-studio-review/${theme}-${width}.png` })
    const bounds = await dialog.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    const contrast = await dialog.getByRole('combobox', { name: '口型参数', exact: true }).evaluate(el => {
      const style = getComputedStyle(el)
      const lum = (s: string) => s.match(/[\d.]+/g)!.slice(0,3).map(Number).map(n => { n /= 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4 }).reduce((s, n, i) => s + n * [.2126, .7152, .0722][i]!, 0)
      const a = lum(style.color), b = lum(style.backgroundColor)
      return (Math.max(a,b) + .05) / (Math.min(a,b) + .05)
    })
    expect(contrast).toBeGreaterThanOrEqual(4.5)
    await dialog.getByRole('button', { name: '关闭模型工作室' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: '导入或校准模型' })).toBeFocused()
    expect(await page.evaluate(() => (window as unknown as { __modelDestroyCount: () => number }).__modelDestroyCount())).toBeGreaterThan(0)
  })
}

test('real builtin Cubism with downsampled fixture texture previews and cleans up', async ({ page }) => {
  test.setTimeout(90000)
  await openStudio(page, 'light', false)
  const dialog = page.getByRole('dialog', { name: '模型导入与校准' })
  const previewDir = path.resolve('runtime/model-studio-review/nene-preview')
  cpSync(path.resolve('assets/live2d/nene'), previewDir, { recursive: true })
  // The original 8192² atlas intentionally exceeds the new-import pixel limit.
  // Keep source assets unchanged and test the real SDK with a bounded texture copy.
  await sharp(path.resolve('assets/live2d/nene/textures/texture_00.png')).resize(2048).png().toFile(path.join(previewDir, 'textures/texture_00.png'))
  await dialog.getByLabel('模型文件夹', { exact: true }).setInputFiles(previewDir)
  await expect(dialog.getByText('文件检查 · 通过')).toBeVisible({ timeout: 30000 })
  await dialog.getByRole('button', { name: '加载预览', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('个真实参数', { timeout: 40000 })
  await expect(dialog.locator('canvas')).toBeVisible()
  await expect.poll(async () => {
    const stats = await sharp(await dialog.locator('canvas').screenshot()).stats()
    return Math.max(...stats.channels.slice(0, 3).map(channel => channel.stdev))
  }, { timeout: 15000, message: 'The actual model must paint visible pixels, not merely report loaded' }).toBeGreaterThan(8)
  await page.screenshot({ path: 'runtime/model-studio-review/real-builtin-preview.png' })
  await dialog.getByRole('button', { name: '释放预览' }).click()
  await expect(dialog.locator('canvas')).toHaveCount(0)
})

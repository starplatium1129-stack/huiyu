import { test, expect } from '@playwright/test'
import fs from 'node:fs'

// Explicit opt-in: these are private creator assets, never replaced with a mock render.
test.skip(process.env.AICS_LIVE2D_IMPORTS !== '1', 'Requires local candidate imports')
for (const theme of ['dark', 'light']) {
  test(`local imported models render and switch in ${theme}`, async ({ page }) => {
    test.setTimeout(180_000)
    await page.addInitScript(theme => {
      localStorage.setItem('aics_theme', theme)
      localStorage.setItem('aics_live2d_quality_v1', 'compact')
      // Observe the real library and model without replacing either with a fixture.
      let library: any
      Object.defineProperty(window, 'wl-live2d', { configurable: true, get: () => library, set(value) {
        const create = value.wlLive2d
        value.wlLive2d = (options: any) => {
          const app = create(options)
          app.onModelLoaded((model: any) => { (window as any).__live2dActual = { model, app } })
          return app
        }
        library = value
      } })
    }, theme)
    await page.goto('/chat')
    await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme)
    const host = page.locator('.live2d-host')
    for (const name of ['初音未来', '芙莉莲', '菲伦', '长离', '蕾姆', '芙宁娜', '绫地宁宁']) {
      await page.getByRole('combobox', { name: '切换角色', exact: true }).click()
      await page.getByRole('option', { name: new RegExp(name) }).click()
      const enable = page.locator('.live2d-enable-cta')
      if (await enable.isVisible()) await enable.click()
      await expect(host).toHaveAttribute('data-state', 'ready', { timeout: 40_000 })
      await expect(host.locator('canvas')).toBeVisible()
      await page.waitForTimeout(1000)
      await page.screenshot({ path: `runtime/live2d-import-review/${theme}-${name}.png` })
      const snapshot = await page.evaluate(() => {
        const model = (window as any).__live2dActual.model
        const core = model.internalModel.coreModel
        const raw = core.getModel?.()
        return {
          natural: { width: model.width / model.scale.x, height: model.height / model.scale.y },
          parameters: raw?.parameters ? Array.from(raw.parameters.ids).map((id, i) => ({ id,
            min: raw.parameters.minimumValues[i], max: raw.parameters.maximumValues[i], default: raw.parameters.defaultValues[i] })) : [],
          motionGroups: Object.keys(model.internalModel.motionManager.definitions),
        }
      })
      fs.writeFileSync(`runtime/live2d-import-review/${theme}-${name}-model.json`, JSON.stringify(snapshot, null, 2))
      await expect(page.getByRole('combobox', { name: 'Live2D 表情', exact: true })).toHaveCount(0)
      const stage = await page.locator('.portrait-stage').boundingBox()
      expect(stage!.height).toBeGreaterThan(450)
      expect(stage!.width).toBeGreaterThan(500)

    }
  })
}

test('imported character controls fit a narrow companion window', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 480, height: 720 })
  await page.goto('/companion')
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme)
    const picker = page.getByRole('combobox', { name: '切换陪伴角色', exact: true })
    await picker.click()
    await page.locator('.companion-picker-option[data-value="changli_wuthering"]').click()
    const enable = page.locator('.live2d-enable-cta')
    if (await enable.isVisible()) await enable.click()
    await expect(page.locator('.live2d-host')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })
    await expect(page.locator('.live2d-host canvas')).toBeInViewport({ ratio: 0.99 })
    await page.waitForTimeout(700)
    await page.screenshot({ path: `runtime/live2d-import-review/companion-${theme}.png` })
    const box = await picker.boundingBox()
    expect(box!.x + box!.width).toBeLessThanOrEqual(480)
    const control = picker
    await expect(page.getByRole('combobox', { name: 'Live2D 表情', exact: true })).toHaveCount(0)
    await expect(control).toBeVisible()
    const contrast = await control.evaluate(el => {
      const style = getComputedStyle(el)
      const linear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      const luminance = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => linear(v / 255)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0)
      const a = luminance(style.color), b = luminance(style.backgroundColor)
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    })
    expect(contrast).toBeGreaterThanOrEqual(4.5)
  }
})

test('largest imported atlas and multi-atlas models render at all three quality levels', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/chat')
  for (const [name, id] of [['芙莉莲', 'frieren'], ['菲伦', 'fern_frieren']]) {
    await page.getByRole('combobox', { name: '切换角色', exact: true }).click()
    await page.getByRole('option', { name: new RegExp(name) }).click()
    const enable = page.locator('.live2d-enable-cta')
    if (await enable.isVisible()) await enable.click()
    await expect(page.locator('.live2d-host')).toHaveAttribute('data-state', 'ready', { timeout: 40_000 })
    for (const quality of ['original', 'standard', 'compact']) {
      await page.locator('.character-controls > summary').click()
      const select = page.getByRole('combobox', { name: 'Live2D 画质', exact: true })
      if (await select.inputValue() !== quality) {
        const manifest = quality === 'original' ? `/api/live2d-local/${id}/${id}.model3.json` : `/api/live2d-model/${id}/${quality}`
        const loaded = page.waitForResponse(response => response.url().endsWith(manifest) && response.ok())
        await select.selectOption(quality)
        await loaded
      }
      await expect(page.locator('.live2d-host')).toHaveAttribute('data-state', 'ready', { timeout: 40_000 })
      await page.locator('.character-controls > summary').click()
      await page.waitForTimeout(1000)
      await page.locator('.portrait-stage').screenshot({ path: `runtime/live2d-import-review/quality-${id}-${quality}.png` })
    }
  }
})

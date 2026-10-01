import { expect, test } from '@playwright/test'
import sharp from 'sharp'
import ports from '../../scripts/lib/e2e-ports.js'
import { pickStudioOptionByValue } from './helpers/studioSelect'

// Real Rust generation/storage with a neutral raster from the isolated mock provider.
for (const theme of ['dark', 'light']) {
  for (const size of ['896x1344', '1344x896']) {
    test(`desktop canvas keeps artwork space ${theme} ${size}`, async ({ page, request }, info) => {
      const [width, height] = size.split('x').map(Number)
      const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#b9c9d0"/><circle cx="${width * .7}" cy="${height * .25}" r="${width * .13}" fill="#eee5ce"/><path d="M0 ${height * .65}Q${width * .3} ${height * .35} ${width} ${height * .7}V${height}H0Z" fill="#61797d"/></svg>`
      const imageBase64 = (await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64')
      for (const port of [ports.sd, ports.comfy || ports.translate + 1, ports.ollama, ports.tts, ports.translate]) {
        await request.post(`http://127.0.0.1:${port}/__mock/reset`)
      }
      await request.post(`http://127.0.0.1:${ports.sd}/__mock/fault`, { data: { imageBase64, renderMs: 30 } })
      await page.setViewportSize({ width: 1920, height: 1080 })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.addInitScript(value => { localStorage.setItem('aics_theme', value); localStorage.setItem('aics_guest_guide_dismissed', '1') }, theme)
      await page.goto('/prompt-builder?scene=sc001')
      await page.getByRole('button', { name: '专家模式', exact: true }).click()
      await page.locator('.engine-switch button').first().click()
      await expect(page.locator('.api-status .badge')).toHaveText(/SD 已连接/)
      await pickStudioOptionByValue(page.locator('.gen-bar-size').getByRole('combobox'), size)
      const before = (await page.locator('#drawing-canvas').boundingBox())!
      expect(before.width).toBeGreaterThan(1050)
      expect(before.height).toBeGreaterThan(650)
      await page.getByRole('button', { name: '生成图片', exact: true }).click()
      const image = page.locator('.result-image')
      await expect(image).toBeVisible({ timeout: 15_000 })
      await expect.poll(() => image.evaluate((node: HTMLImageElement) => [node.naturalWidth, node.naturalHeight])).toEqual([width, height])
      const after = (await page.locator('#drawing-canvas').boundingBox())!
      expect(Math.abs(after.width - before.width)).toBeLessThan(2)
      expect(Math.abs(after.height - before.height)).toBeLessThan(2)
      await expect(page.getByRole('button', { name: '生成图片', exact: true })).toBeInViewport({ ratio: 1 })
      const clear = page.locator('.gen-bar').getByRole('button', { name: '清除图片', exact: true })
      await expect(clear).toBeEnabled()
      await expect(clear).toBeInViewport({ ratio: 1 })
      await page.getByRole('tab', { name: '成片', exact: true }).click()
      await expect(page.locator('#drawing-inspector').getByRole('button', { name: '生成短片', exact: true })).toBeVisible()
      await expect(page.locator('#drawing-inspector').getByRole('button', { name: '高清放大 2x', exact: true })).toBeVisible()
      await expect(page.locator('#drawing-canvas').getByRole('button', { name: '生成短片', exact: true })).toHaveCount(0)
      await page.screenshot({ path: info.outputPath(`canvas-artwork-${theme}-${size}.png`) })
      if (size === '1344x896') {
        for (const viewport of [{ width: 2560, height: 1440 }, { width: 3840, height: 2160 }, { width: 1280, height: 800 }]) {
          await page.setViewportSize(viewport)
          await expect(page.locator('.gen-bar').getByRole('button', { name: '生成图片', exact: true })).toBeInViewport({ ratio: 1 })
          await expect(clear).toBeInViewport({ ratio: 1 })
          await expect(page.locator('#drawing-inspector').getByRole('button', { name: '生成短片', exact: true })).toBeInViewport({ ratio: 1 })
          await page.screenshot({ path: info.outputPath('canvas-controls-' + theme + '-' + viewport.width + '.png') })
        }
      }
      await clear.click()
      await expect(image).toHaveCount(0)
      await expect(clear).toBeDisabled()
    })
  }
}

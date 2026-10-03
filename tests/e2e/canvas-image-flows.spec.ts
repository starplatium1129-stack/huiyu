import { expect, test } from '@playwright/test'
import sharp from 'sharp'
import ports from '../../scripts/lib/e2e-ports.js'
import { pickStudioOptionByValue } from './helpers/studioSelect'
import { textContrast } from './helpers/contrast'

// Real Rust generation/storage with a neutral raster from the isolated mock provider.
for (const theme of ['dark', 'light']) {
  for (const size of theme === 'dark' ? ['896x1344', '1344x896', '1024x1024'] : ['896x1344', '1344x896']) {
    test(`desktop canvas keeps artwork space ${theme} ${size}`, async ({ page, request }, info) => {
      const [width, height] = size.split('x').map(Number)
      const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#b9c9d0"/><circle cx="${width * .7}" cy="${height * .25}" r="${width * .13}" fill="#eee5ce"/><path d="M0 ${height * .65}Q${width * .3} ${height * .35} ${width} ${height * .7}V${height}H0Z" fill="#61797d"/></svg>`
      const imageBase64 = (await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64')
      const reduced = theme === 'light' && size === '896x1344'
      for (const port of [ports.sd, ports.comfy || ports.translate + 1, ports.ollama, ports.tts, ports.translate]) {
        await request.post(`http://127.0.0.1:${port}/__mock/reset`)
      }
      await request.post(`http://127.0.0.1:${ports.sd}/__mock/fault`, { data: { imageBase64, renderMs: size === '1344x896' ? 6000 : 30 } })
      await page.setViewportSize({ width: 1920, height: 1080 })
      await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' })
      await page.addInitScript(value => { localStorage.setItem('aics_theme', value); localStorage.setItem('aics_guest_guide_dismissed', '1') }, theme)
      await page.route('**/scene-showcase/manifest.json', route => route.fulfill({ json: { entries: [{ id: 'sc001', type: 'scene', char: 'nene', title: '场景参考', rating: 'All' }] } }))
      await page.route('**/scene-showcase/thumbs/sc001.jpg', route => route.fulfill({ contentType: 'image/png', body: Buffer.from(imageBase64, 'base64') }))
      await page.goto('/prompt-builder?scene=sc001')
      await page.getByRole('button', { name: '专家模式', exact: true }).click()
      await page.locator('.engine-switch button').first().click()
      await expect(page.locator('.api-status .badge')).toHaveText(/SD 已连接/)
      await pickStudioOptionByValue(page.locator('.gen-bar-size').getByRole('combobox'), size)
      const before = (await page.locator('#drawing-canvas').boundingBox())!
      expect(before.width).toBeGreaterThan(1920 / 2)
      expect(before.height).toBeGreaterThan(650)
      // Freeze the first actual reveal when it is attached, before test-runner
      // polling can miss a sub-second animation. The application path is unchanged.
      if (!reduced) await page.evaluate(() => {
        const observer = new MutationObserver(() => {
          const layer = document.querySelector('.cg-development-reveal')
          if (!layer) return
          layer.parentElement?.getAnimations({ subtree: true }).forEach(animation => { animation.pause(); animation.currentTime = 0 })
          observer.disconnect()
        })
        observer.observe(document.body, { childList: true, subtree: true })
      })
      await page.getByRole('button', { name: '生成图片', exact: true }).click()
      if (size === '1344x896') {
        await expect(page.locator('.stage-placeholder .stage-generating-copy')).toBeVisible()
        await expect(page.getByRole('progressbar', { name: '生图进度' })).toBeVisible()
        expect(await page.locator('.stage-generating-title').evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
        expect(await page.locator('.stage-generating-sub').evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
        await expect(page.locator('.stage-generating-copy .thinking-orb-host')).not.toHaveClass(/is-paused/)
        await expect(page.locator('.stage-generating-copy .thinking-orb-canvas')).toBeVisible()
        await page.screenshot({ path: info.outputPath('canvas-generating-' + theme + '-1920.png'), animations: 'allow' })
        for (const viewport of [{ width: 2560, height: 1440 }, { width: 3840, height: 2160 }, { width: 1280, height: 800 }]) {
          await page.setViewportSize(viewport)
          await expect(page.getByRole('progressbar', { name: '生图进度' })).toBeInViewport({ ratio: 1 })
          await expect(page.getByRole('button', { name: '停止绘制', exact: true })).toBeInViewport({ ratio: 1 })
          await page.screenshot({ path: info.outputPath(`canvas-generating-${theme}-${viewport.width}.png`), animations: 'allow' })
        }
        await page.setViewportSize({ width: 1920, height: 1080 })
      }
      const image = page.locator('.result-image')
      await expect(image).toBeVisible({ timeout: 15_000 })
      await expect.poll(() => image.evaluate((node: HTMLImageElement) => [node.naturalWidth, node.naturalHeight])).toEqual([width, height])
      if (!reduced) {
        await expect(page.locator('.cg-development-reveal')).toBeVisible()
        expect(await page.locator('.cg-development-reveal').evaluate(element => element.getAnimations({ subtree: true }).length)).toBeGreaterThan(0)
        for (const time of [80, 300, 540]) {
          await page.locator('.cg-image-reveal').evaluate((element, time) => {
            element.getAnimations({ subtree: true }).forEach(animation => { animation.currentTime = time })
          }, time)
          await page.screenshot({ path: info.outputPath(`canvas-image-developing-${theme}-${time}.png`), animations: 'allow' })
        }
        await page.locator('.cg-image-reveal').evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => animation.finish()))
      }
      await expect(page.locator('.cg-development-reveal')).toHaveCount(0)
      await expect(image).toHaveCSS('opacity', '1')
      await expect(image).toHaveCSS('transform', 'none')
      const light = page.getByRole('button', { name: '作品环境光', exact: true })
      await expect(page.locator('.canvas-ambient')).toHaveClass(/is-enabled/)
      const palette = await page.locator('.result-image-wrap').evaluate(node => node.style.getPropertyValue('--canvas-ambient-1'))
      expect(palette).not.toBe('')
      await light.click()
      await expect(light).toHaveAttribute('aria-pressed', 'false')
      await expect(page.locator('.canvas-ambient')).not.toHaveClass(/is-enabled/)
      await expect(image).toHaveCSS('opacity', '1')
      await light.click()
      await expect(light).toHaveAttribute('aria-pressed', 'true')
      const imageBounds = await image.boundingBox()
      expect(imageBounds!.height).toBeGreaterThan(650)
      await expect(page.locator('#drawing-canvas .gen-bar')).toHaveCount(0)
      await expect(page.locator('#drawing-inspector .gen-bar')).toBeVisible()
      const after = (await page.locator('#drawing-canvas').boundingBox())!
      expect(Math.abs(after.width - before.width)).toBeLessThan(2)
      expect(Math.abs(after.height - before.height)).toBeLessThan(2)
      await expect(page.getByRole('button', { name: '生成图片', exact: true })).toBeInViewport({ ratio: 1 })
      const clear = page.locator('.gen-bar').getByRole('button', { name: '清除图片', exact: true })
      await expect(clear).toBeEnabled()
      await expect(clear).toBeInViewport({ ratio: 1 })
      await page.locator('.image-continuation > summary').click()
      await expect(page.locator('#drawing-inspector').getByRole('button', { name: '生成短片', exact: true })).toBeVisible()
      await expect(page.locator('#drawing-inspector').getByRole('button', { name: '高清放大 2x', exact: true })).toBeVisible()
      await expect(page.locator('#drawing-canvas').getByRole('button', { name: '生成短片', exact: true })).toHaveCount(0)
      await expect(page.locator('#drawing-canvas').getByRole('group', { name: '结果来源', exact: true })).toHaveCount(0)
      const candidates = page.locator('#drawing-inspector').getByText('候选与最近作品', { exact: true })
      await expect(candidates).toHaveCount(0)
      await expect(page.locator('#drawing-inspector .result-shelf')).toHaveCount(0)
      await page.screenshot({ path: info.outputPath(`canvas-artwork-${theme}-${size}.png`) })
      await info.attach('display-context', { body: JSON.stringify(await page.evaluate(() => ({ cssViewport: [innerWidth, innerHeight], devicePixelRatio, browserZoom: visualViewport?.scale, physicalDisplay: 'not sampled; isolated desktop browser, not native DPI validation' }))), contentType: 'application/json' })
      if (size === '896x1344') {
        await page.setViewportSize({ width: 1024, height: 720 })
        const painted = await image.evaluate((node: HTMLImageElement) => {
          const box = node.getBoundingClientRect(), ratio = node.naturalWidth / node.naturalHeight
          return { width: Math.min(box.width, box.height * ratio), height: Math.min(box.height, box.width / ratio) }
        })
        expect(painted.width).toBeGreaterThanOrEqual(245)
        expect(painted.height).toBeGreaterThanOrEqual(365)
        await expect(page.getByRole('button', { name: '存入作品册', exact: true })).toBeInViewport({ ratio: 1 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024)
        await page.screenshot({ path: info.outputPath(`canvas-portrait-${theme}-1024.png`) })
        await page.setViewportSize({ width: 1920, height: 1080 })
      }
      if (size === '1344x896') {
        for (const viewport of [{ width: 2560, height: 1440 }, { width: 3840, height: 2160 }, { width: 1280, height: 800 }]) {
          await page.setViewportSize(viewport)
          await expect(page.locator('.gen-bar').getByRole('button', { name: '生成图片', exact: true })).toBeInViewport({ ratio: 1 })
          await expect(clear).toBeInViewport({ ratio: 1 })
          await page.locator('#drawing-inspector').getByRole('button', { name: '生成短片', exact: true }).scrollIntoViewIfNeeded()
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

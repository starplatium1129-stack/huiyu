import { expect, test } from '@playwright/test'
import { build } from 'esbuild'

type GlassApi = typeof import('../../src/utils/fluidGlassRenderer')

test('glass maps use async encoding, share matching geometry and preserve lens pixels', async ({ page }) => {
  const bundle = await build({ stdin: { contents: "export * from './src/utils/fluidGlassRenderer'", resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', globalName: 'GlassFixture' })
  await page.setContent('<style>.nav{width:300px;height:80px;border-radius:20px}</style><div class="nav"></div><div class="nav"></div>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const result = await page.evaluate(async () => {
    const api = (window as unknown as { GlassFixture: GlassApi }).GlassFixture
    const root = document.documentElement; root.dataset.glassMaterial = 'liquid'
    let encodes = 0
    const originalBlob = HTMLCanvasElement.prototype.toBlob, originalUrl = HTMLCanvasElement.prototype.toDataURL
    HTMLCanvasElement.prototype.toDataURL = () => { throw new Error('Synchronous glass encoding is forbidden') }
    HTMLCanvasElement.prototype.toBlob = function (...args) { encodes++; originalBlob.apply(this, args) }
    const stop = api.mountFluidGlass()
    try {
      await new Promise<void>((resolve, reject) => {
        const started = performance.now()
        function check() {
          if (document.querySelectorAll('[data-fluid-refracted]').length === 2) resolve()
          else if (performance.now() - started > 4000) reject(new Error('Glass maps never became ready'))
          else requestAnimationFrame(check)
        }
        check()
      })
      const href = document.querySelector('feImage')!.getAttribute('href')!
      const image = new Image(); image.src = href; await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!; ctx.drawImage(image, 0, 0)
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      let mismatches = 0
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const [dx, dy] = api.fluidLens(300, 80, 20, x + .5, y + .5), i = (y * canvas.width + x) * 4
        if (pixels[i] !== Math.round(127.5 + dx / 32 * 255) || pixels[i + 1] !== Math.round(127.5 + dy / 32 * 255)) mismatches++
      }
      return { encodes, mismatches }
    } finally { stop(); HTMLCanvasElement.prototype.toBlob = originalBlob; HTMLCanvasElement.prototype.toDataURL = originalUrl }
  })
  expect(result).toEqual({ encodes: 1, mismatches: 0 })
})

test('disposing glass while encoding prevents late filters from returning', async ({ page }) => {
  const bundle = await build({ stdin: { contents: "export * from './src/utils/fluidGlassRenderer'", resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', globalName: 'GlassFixture' })
  await page.setContent('<div class="nav" style="width:300px;height:80px;border-radius:20px"></div>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const result = await page.evaluate(async () => {
    const api = (window as unknown as { GlassFixture: GlassApi }).GlassFixture
    document.documentElement.dataset.glassMaterial = 'liquid'
    const original = HTMLCanvasElement.prototype.toBlob
    let release: (() => void) | undefined
    HTMLCanvasElement.prototype.toBlob = function (...args) { release = () => original.apply(this, args) }
    const stop = api.mountFluidGlass()
    await new Promise<void>((resolve, reject) => {
      const started = performance.now()
      function check() { if (release) resolve(); else if (performance.now() - started > 4000) reject(new Error('Encoding did not start')); else requestAnimationFrame(check) }
      check()
    })
    stop(); release!()
    await new Promise(resolve => setTimeout(resolve, 150))
    HTMLCanvasElement.prototype.toBlob = original
    return { surfaces: document.querySelectorAll('[data-fluid-refracted]').length, filters: document.querySelectorAll('.fluid-glass-definitions').length }
  })
  expect(result).toEqual({ surfaces: 0, filters: 0 })
})

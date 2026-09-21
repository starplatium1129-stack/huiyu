import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import type { ParticleBodyPoint, ParticleBodyStyle } from '../../src/utils/particleBody'

type Api = typeof import('../../src/utils/particleGpu') & typeof import('../../src/utils/particleBody')

test.beforeEach(async ({ page }) => {
  const bundle = await build({ stdin: { contents: "export * from './src/utils/particleGpu'; export * from './src/utils/particleBody'", resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', globalName: 'ParticleFixture' })
  await page.setContent('<main></main>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
})

for (const darkTheme of [false, true]) for (const dpr of [1, 1.5, 2]) {
  test(`GPU keeps portrait colors, outlines and tails ${darkTheme ? 'dark' : 'light'} DPR ${dpr}`, async ({ page }, info) => {
    const result = await page.evaluate(({ darkTheme, dpr }) => {
      const api = (window as unknown as { ParticleFixture: Api }).ParticleFixture
      const renderer = api.createParticleGpuRenderer()
      if (!renderer) throw new Error('This browser did not create the GPU renderer')
      let width = 480, height = 320
      const create = () => {
        const canvas = document.createElement('canvas'); canvas.width = width * dpr; canvas.height = height * dpr
        canvas.style.width = `${width}px`; canvas.style.height = `${height}px`
        document.querySelector('main')!.append(canvas)
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!; ctx.scale(dpr, dpr)
        return { canvas, ctx }
      }
      const reference = create(), accelerated = create()
      const points: ParticleBodyPoint[] = Array.from({ length: 1800 }, (_, i) => {
        const x = 15 + i % 50 * 9, y = 12 + Math.floor(i / 50) * 8
        return { x, y, prevX: x, prevY: y, targetX: x, targetY: y, tone: 0, paint: i % 3, size: 1 }
      })
      const style: ParticleBodyStyle = { paints: ['#ffffff', '#303040', '#ee9abc'], radii: [1.05, 1.05, 1.05], darkTheme, energyScale: 1, surface: darkTheme ? '#211c30' : '#e7e0ed', outline: '#3c3548', palette: { primary: '#ffffff', secondary: '#999999', accent: '#ee9abc' } }
      const compare = () => {
        for (const target of [reference, accelerated]) target.ctx.clearRect(0, 0, width, height)
        api.drawParticleBody(reference.ctx, points, style)
        if (!renderer.draw(accelerated.ctx, width, height, dpr, points, style)) throw new Error('GPU unexpectedly fell back')
        // Compare the visible result on the real theme surface, not invisible RGB
        // in near-transparent edge pixels. Analytic GPU AA differs from Skia AA.
        for (const target of [reference, accelerated]) {
          target.ctx.globalCompositeOperation = 'destination-over'; target.ctx.fillStyle = style.surface
          target.ctx.fillRect(0, 0, width, height); target.ctx.globalCompositeOperation = 'source-over'
        }
        const a = reference.ctx.getImageData(0, 0, reference.canvas.width, reference.canvas.height).data
        const b = accelerated.ctx.getImageData(0, 0, accelerated.canvas.width, accelerated.canvas.height).data
        let sum = 0, large = 0
        for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) {
          const difference = Math.abs(a[i + c] - b[i + c]); sum += difference; if (difference > 32) large++
        }
        return { mean: sum / (a.length / 4 * 3), large: large / (a.length / 4 * 3) }
      }
      const comparisons = [compare()]
      for (const p of points) if (Math.hypot(p.x - 240, p.y - 160) < 70) { p.prevX -= 8; p.x += 13; p.y -= 6 }
      comparisons.push(compare())
      // Same-color overlap must be a union, not repeated alpha accumulation.
      for (let i = 0; i < 120; i++) { points[i].x = 240 + i % 3 * 2; points[i].y = 150; points[i].prevX = 240; points[i].prevY = 150 }
      comparisons.push(compare())
      style.darkTheme = !darkTheme; style.surface = style.darkTheme ? '#211c30' : '#e7e0ed'
      style.paints = ['#f3cfaa', '#123456', '#aaccee']; style.energyScale = 1.16
      comparisons.push(compare())
      width = 361; height = 241
      for (const target of [reference, accelerated]) { target.canvas.width = Math.round(width * dpr); target.canvas.height = Math.round(height * dpr); target.ctx.scale(dpr, dpr) }
      comparisons.push(compare())
      renderer.release()
      const released = renderer.draw(accelerated.ctx, width, height, dpr, points, style)
      return { comparisons, released }
    }, { darkTheme, dpr })
    await info.attach('gpu-raster-differences', { body: JSON.stringify(result), contentType: 'application/json' })
    for (const comparison of result.comparisons) {
      expect(comparison.mean).toBeLessThan(1.5)
      expect(comparison.large).toBeLessThan(.012)
    }
    expect(result.released).toBe(false)
  })
}

test('GPU context loss and unsupported devices return control to Canvas', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = (window as unknown as { ParticleFixture: Api }).ParticleFixture
    const getContext = HTMLCanvasElement.prototype.getContext
    let gpuContext: WebGL2RenderingContext | null = null
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, options?: unknown) {
      const context = getContext.call(this, kind, options as object)
      if (kind === 'webgl2') gpuContext = context as WebGL2RenderingContext
      return context
    } as typeof getContext
    const renderer = api.createParticleGpuRenderer()!
    HTMLCanvasElement.prototype.getContext = getContext
    const gl = gpuContext as unknown as WebGL2RenderingContext
    const lost = new Promise<void>(resolve => gl.canvas.addEventListener('webglcontextlost', () => resolve(), { once: true }))
    gl.getExtension('WEBGL_lose_context')!.loseContext()
    await lost
    const ctx = document.createElement('canvas').getContext('2d')!
    const style: ParticleBodyStyle = { paints: ['#ffffff'], radii: [1], darkTheme: false, energyScale: 1, surface: '#e7e0ed', outline: '#3c3548', palette: { primary: '#ffffff', secondary: '#999999', accent: '#ee9abc' } }
    const drawsAfterLoss = renderer.draw(ctx, 100, 100, 1, [], style)
    renderer.release()
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, options?: unknown) {
      return kind === 'webgl2' ? null : getContext.call(this, kind, options as object)
    } as typeof getContext
    const unavailable = api.createParticleGpuRenderer()
    HTMLCanvasElement.prototype.getContext = getContext
    return { drawsAfterLoss, unavailable }
  })
  expect(result).toEqual({ drawsAfterLoss: false, unavailable: null })
})

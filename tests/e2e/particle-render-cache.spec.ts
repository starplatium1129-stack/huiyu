import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import type { ParticleBodyPoint, ParticleBodyStyle } from '../../src/utils/particleBody'

type BodyApi = typeof import('../../src/utils/particleBody') & typeof import('../../src/utils/particleSnapshot')

for (const darkTheme of [false, true]) {
  for (const dpr of [1, 1.5, 2]) {
    test(`cached portrait matches full Path2D output ${darkTheme ? 'dark' : 'light'} DPR ${dpr}`, async ({ page }, info) => {
      const bundle = await build({ stdin: { contents: "export * from './src/utils/particleBody'; export * from './src/utils/particleSnapshot'", resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', globalName: 'ParticleFixture' })
      await page.setContent('<main>Particle raster comparison fixture</main>')
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      const results = await page.evaluate(({ darkTheme, dpr }) => {
        const api = (window as unknown as { ParticleFixture: BodyApi }).ParticleFixture
        const width = 480, height = 320
        const create = () => {
          const canvas = document.createElement('canvas'); canvas.width = width * dpr; canvas.height = height * dpr
          // Keep both rasterizers on the same backend for exact edge comparisons.
          // Real GPU rendering is exercised separately by the archive browser tests.
          const context = canvas.getContext('2d', { willReadFrequently: true })!; context.scale(dpr, dpr)
          return { canvas, context }
        }
        const full = create(), cached = create(), snapshot = api.createParticleSnapshot()
        const particles: ParticleBodyPoint[] = Array.from({ length: 1800 }, (_, i) => {
          const x = 15 + i % 50 * 9, y = 12 + Math.floor(i / 50) * 8
          return { x, y, prevX: x, prevY: y, targetX: x, targetY: y, tone: 0, paint: i % 3, size: 1 }
        })
        const style: ParticleBodyStyle = { paints: ['#ffffff', '#303040', '#ee9abc'], radii: [1.05, 1.05, 1.05], darkTheme, energyScale: 1, surface: darkTheme ? '#211c30' : '#e7e0ed', outline: '#3c3548', palette: { primary: '#ffffff', secondary: '#999999', accent: '#ee9abc' } }
        const compare = () => {
          full.context.clearRect(0, 0, width, height); cached.context.clearRect(0, 0, width, height)
          api.drawParticleBody(full.context, particles, style)
          snapshot.draw(cached.context, width, height, dpr, particles, style)
          const a = full.context.getImageData(0, 0, full.canvas.width, full.canvas.height).data
          const b = cached.context.getImageData(0, 0, cached.canvas.width, cached.canvas.height).data
          let total = 0, large = 0
          for (let i = 0; i < a.length; i++) { const difference = Math.abs(a[i] - b[i]); total += difference; if (difference > 3) large++ }
          return { mean: total / a.length, changed: large / a.length }
        }
        const output = [compare()]
        for (const p of particles) {
          if (Math.hypot(p.x - 240, p.y - 160) < 42) { p.prevX += 8; p.prevY -= 3; p.x += 14; p.y -= 6 }
        }
        output.push(compare())
        // Move to a different region to expose stale holes and old trails.
        for (const p of particles) {
          p.x = p.prevX = p.targetX; p.y = p.prevY = p.targetY
          if (p.x > 370 && p.y < 80) { p.prevX -= 4; p.x -= 8; p.y += 10 }
        }
        output.push(compare())
        style.paints = ['#f3cfaa', '#123456', '#aaccee']; snapshot.invalidate(); output.push(compare())
        snapshot.release()
        return output
      }, { darkTheme, dpr })
      await info.attach('pixel-differences', { body: JSON.stringify(results), contentType: 'application/json' })
      for (const result of results) {
        expect(result.mean).toBeLessThan(.25)
        expect(result.changed).toBeLessThan(.005)
      }
    })
  }
}

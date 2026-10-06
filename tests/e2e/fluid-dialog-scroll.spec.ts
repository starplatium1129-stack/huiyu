import { expect, test } from '@playwright/test'
import { installShowcaseFixture } from './helpers/showcase'

for (const theme of ['dark']) {
  for (const motion of ['no-preference', 'reduce'] as const) {
    test(`native close cannot expose a top-of-page frame ${theme} ${motion}`, async ({ page }, info) => {
      await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
      await page.emulateMedia({ reducedMotion: motion })
      await installShowcaseFixture(page)
      await page.route('**/scene-showcase/manifest.json', route => route.fulfill({ json: {
        entries: Array.from({ length: 48 }, (_, i) => ({ id: `close-scroll-${i}`, title: `滚动恢复 ${i}`, char: 'nene', rating: 'All', type: 'scene', width: 832, height: 1216 })),
      } }))
      await page.goto('/showcase')
      const opener = page.locator('.sample-visual').nth(20)
      await opener.scrollIntoViewIfNeeded()
      await opener.click()
      const dialog = page.locator('dialog.showcase-viewer')
      await expect(dialog).toHaveCSS('opacity', '1')
      const originalY = await page.evaluate(() => scrollY)
      expect(originalY).toBeGreaterThan(1000)

      const result = await dialog.evaluate(element => new Promise<{ frames: number[]; delayedEvents: number }>(resolve => {
        const el = element as HTMLDialogElement
        const nativeClose = el.close.bind(el)
        let forwarding = false, delayedEvents = 0, closedFrames = 0
        const frames: number[] = []
        // WebView may restore focus synchronously inside close(), while its close
        // event arrives in a later rendering opportunity. Model both halves;
        // injecting a reset only inside the event misses the exposed top frame.
        el.close = value => { nativeClose(value); window.scrollTo({ left: 0, top: 0, behavior: 'instant' }) }
        el.addEventListener('close', event => {
          if (forwarding) return
          event.stopImmediatePropagation(); delayedEvents++
          requestAnimationFrame(() => {
            forwarding = true; el.dispatchEvent(new Event('close')); forwarding = false
          })
        }, true)
        const sample = () => {
          frames.push(scrollY)
          if (!el.open && ++closedFrames >= 5) { resolve({ frames, delayedEvents }); return }
          requestAnimationFrame(sample)
        }
        ;(el.querySelector('.viewer-close') as HTMLButtonElement).click()
        requestAnimationFrame(sample)
      }))
      await info.attach('native-close-frame-positions', { body: JSON.stringify({ originalY, ...result }), contentType: 'application/json' })
      expect(result.delayedEvents).toBe(1)
      expect(Math.max(...result.frames.map(y => Math.abs(y - originalY)))).toBeLessThanOrEqual(1)
      await expect(opener).toBeFocused()
      expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe('')
    })
  }
}

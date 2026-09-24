import { expect, test, type Page } from '@playwright/test'
import { installShowcaseFixture } from './helpers/showcase'

type MotionSample = { transform: string; state: string | undefined }
type MotionWindow = Window & { __anchoredMotionSamples?: MotionSample[] }

async function observeMotion(page: Page, selector: string) {
  await page.evaluate(selector => {
    document.documentElement.dataset.motion = 'full'
    window.dispatchEvent(new Event('atelier:motion-preference'))
    const samples: MotionSample[] = []
    ;(window as MotionWindow).__anchoredMotionSamples = samples
    const capture = () => {
      document.querySelectorAll<HTMLElement>(selector).forEach(element => {
        if (samples.length < 1000) {
          const style = getComputedStyle(element)
          samples.push({ transform: style.transform, state: element.dataset.state })
        }
      })
    }
    const observer = new MutationObserver(capture)
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style', 'data-state'], childList: true })
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true })
  }, selector)
}

async function expectMotionWasPlayed(page: Page) {
  await expect.poll(() => page.evaluate(() =>
    (window as MotionWindow).__anchoredMotionSamples?.some(sample =>
      sample.transform !== 'none' && !/^matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\)$/.test(sample.transform),
    ) ?? false,
  )).toBe(true)
}

async function expectSettledTransform(locator: import('@playwright/test').Locator) {
  await expect.poll(() => locator.evaluate(element => getComputedStyle(element).transform)).toMatch(
    /^(?:none|matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\))$/,
  )
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1440, 390]) {
    test(`anchored select motion, reversal and focus ${theme} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 })
      await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: theme })
      await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
      await installShowcaseFixture(page)
      await page.goto('/showcase')
      await expect(page.locator('.sample')).toHaveCount(2)
      await observeMotion(page, '.studio-select-content')
      const trigger = page.getByLabel('筛选作品类型')
      const content = page.locator('.studio-select-content')
      await trigger.press('Enter')
      await expect(content).toBeVisible()
      await expectMotionWasPlayed(page)
      // Interrupt an opening/closing surface instead of waiting for a screenshot
      // state. The new live layer must stay operable and not inherit inert.
      await page.keyboard.press('Escape')
      await trigger.press('Enter')
      await expect(content).toHaveCount(1)
      await expectSettledTransform(content)
      await expect(content).toHaveCSS('will-change', 'auto')
      await expect(content).not.toHaveAttribute('inert')
      await page.keyboard.press('Escape')
      await expect(content).toHaveCount(0)
      await expect(trigger).toBeFocused()
      await expect(page.locator('body')).not.toHaveCSS('pointer-events', 'none')
    })

    test(`anchored popover motion and keyboard dismissal ${theme} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 })
      await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: theme })
      await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
      // UI-only fixtures: no real generation, model call or backend mutation.
      await page.route(/^http:\/\/[^/]+\/api\//, route => route.fulfill({ json: { ok: true, online: false, models: [], loras: [], styleLoras: [] } }))
      await page.route('**/data/tags.json*', route => route.fulfill({ json: [{ en: 'park', cn: '公园', cat: 'Scene' }] }))
      await page.goto('/prompt-builder?mode=pro')
      await page.getByRole('button', { name: '专家模式', exact: true }).click()
      await observeMotion(page, '.studio-popover')
      const trigger = page.getByRole('button', { name: '夏目的调色笔记', exact: true })
      const content = page.getByRole('dialog', { name: '夏目的调色笔记', exact: true })
      await trigger.click()
      await expect(content).toBeVisible()
      await expectMotionWasPlayed(page)
      await expectSettledTransform(content)
      await expect(content).toHaveCSS('will-change', 'auto')
      await page.keyboard.press('Escape')
      await expect(content).toHaveCount(0)
      await expect(trigger).toBeFocused()
      await trigger.press('Enter')
      await expect(content).toBeVisible()
      // App preference changes must settle an active transition, not strand it.
      await page.evaluate(() => {
        document.documentElement.dataset.motion = 'reduce'
        window.dispatchEvent(new Event('atelier:motion-preference'))
      })
      await expectSettledTransform(content)
      await page.keyboard.press('Escape')
      await expect(content).toHaveCount(0)
      await expect(trigger).toBeFocused()
    })
  }
}

import { test, expect, type Locator, type Page } from '@playwright/test'
import { textContrast } from './helpers/contrast'

const appearanceKey = 'atelier-desktop-appearance-v1'
const chromeRoutes = [
  ['/', '.nav'], ['/scene-explorer', '.scene-toolbar'],
  ['/popular-scenes', '.pop-toolbar'], ['/gallery', '.gallery-toolbar'],
  ['/showcase', '.toolbar-shell'], ['/prompt-builder', '.gen-bar'],
] as const

async function openAppearance(page: Page) {
  await expect(page.locator('.nav')).toBeVisible()
  const toggle = page.locator('.nav-menu-toggle')
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  await page.locator('.nav-more-trigger').click()
  await page.getByRole('button', { name: '外观与动态效果', exact: true }).click()
  await expect(page.locator('.appearance-dialog')).toBeVisible()
  await expect(page.locator('.appearance-dialog')).toHaveCSS('opacity', '1')
}

async function setGlassPreference(page: Page, reduced: boolean) {
  await openAppearance(page)
  await page.getByRole('checkbox', { name: /降低玻璃效果/ }).setChecked(reduced)
  await page.keyboard.press('Escape')
  await expect(page.locator('.appearance-dialog')).not.toBeVisible()
}

async function surfaceMetrics(locator: Locator) {
  return locator.evaluate(el => {
    const s = getComputedStyle(el)
    const context = document.createElement('canvas').getContext('2d')!
    const parse = (color: string) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      return [...context.getImageData(0, 0, 1, 1).data]
    }
    const luminance = (color: number[]) => color.slice(0, 3).map(v => v / 255)
      .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
    const background = parse(s.backgroundColor), border = parse(s.borderBottomColor)
    const edge = border.slice(0, 3).map((v, i) => v * border[3] / 255 + background[i] * (1 - border[3] / 255))
    const a = luminance(background), b = luminance(edge)
    return { alpha: background[3], borderRatio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) }
  })
}

async function expectSolid(locator: Locator) {
  await expect(locator).toBeVisible()
  await expect(locator).toHaveCSS('backdrop-filter', 'none')
  await expect(locator).toHaveCSS('background-image', 'none')
  expect((await surfaceMetrics(locator)).alpha).toBe(255)
}

async function expectInstalledLens(locator: Locator) {
  await expect(locator).toHaveAttribute('data-fluid-refracted', '')
  // Registration alone is insufficient: the computed filter must use the lens.
  await expect.poll(() => locator.evaluate(el => {
    const actual = getComputedStyle(el).backdropFilter
    const installed = (el as HTMLElement).style.getPropertyValue('--fluid-glass-filter')
    return actual.startsWith('url(') && actual === installed
  })).toBe(true)
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`U4 glass ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript(({ theme, key }) => {
        // Navigation/reload must exercise the saved preference, not reset it.
        if (!localStorage.getItem(key)) {
          localStorage.setItem('aics_theme', theme)
          localStorage.setItem(key, JSON.stringify({ theme, motion: 'system', reducedGlass: false, glass: 'liquid' }))
        }
      }, { theme, key: appearanceKey })
    })

    test('navigation and generation bar render their installed optics', async ({ page }) => {
      await page.goto('/prompt-builder')
      for (const selector of ['.nav', '.gen-bar']) {
        const surface = page.locator(selector)
        await expect(surface).toBeVisible()
        await expectInstalledLens(surface)
        expect((await surfaceMetrics(surface)).alpha).toBeLessThan(255)
      }
      await expect(page.locator('.gen-bar')).toHaveCSS('position', 'sticky')
      await expect(page.locator('#drawing-materials')).not.toHaveAttribute('data-fluid-refracted')
    })

    test('the real glass preference persists across chrome routes and restores optics', async ({ page }) => {
      test.setTimeout(60_000)
      await page.goto('/')
      await setGlassPreference(page, true)
      for (const [route, selector] of chromeRoutes) {
        await page.goto(route)
        await expectSolid(page.locator('.nav'))
        await expectSolid(page.locator(selector))
        expect(await page.locator('.nav-more-trigger').evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
      }
      await page.reload()
      await expectSolid(page.locator('.gen-bar'))
      await setGlassPreference(page, false)
      await expectInstalledLens(page.locator('.gen-bar'))
    })

    for (const [label, name, value] of [
      ['reduced transparency', 'prefers-reduced-transparency', 'reduce'],
      ['increased contrast', 'prefers-contrast', 'more'],
      ['forced colors', 'forced-colors', 'active'],
    ]) {
      test(`${label} overrides full effects on navigation and toolbars`, async ({ page, context }) => {
        const session = await context.newCDPSession(page)
        await session.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: theme }, { name, value }],
        })
        for (const [route, selector] of [['/popular-scenes', '.pop-toolbar'], ['/prompt-builder', '.gen-bar']]) {
          await page.goto(route)
          expect(await page.evaluate(query => matchMedia(query).matches, `(${name}: ${value})`)).toBe(true)
          for (const surface of [page.locator('.nav'), page.locator(selector)]) {
            await expectSolid(surface)
            if (name !== 'prefers-reduced-transparency') {
              expect((await surfaceMetrics(surface)).borderRatio).toBeGreaterThanOrEqual(3)
            }
          }
        }
        if (name === 'forced-colors') {
          await setGlassPreference(page, true)
          await expectSolid(page.locator('.nav'))
          await expectSolid(page.locator('.gen-bar'))
          expect((await surfaceMetrics(page.locator('.gen-bar'))).borderRatio).toBeGreaterThanOrEqual(3)
        }
        await session.detach()
      })
    }

    for (const width of [1440, 390]) {
      test(`real dialog stays readable, keeps padding clicks and restores focus at ${width}px`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.goto('/popular-scenes')
        const dialog = page.locator('.appearance-dialog')
        for (let cycle = 0; cycle < 3; cycle++) {
          await openAppearance(page)
          await expectSolid(dialog)
          expect(await dialog.locator('h2').evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
          expect(await dialog.locator('.appearance-note').evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
          const rect = (await dialog.boundingBox())!
          expect(rect.x).toBeGreaterThanOrEqual(0)
          expect(rect.x + rect.width).toBeLessThanOrEqual(width)
          await page.mouse.click(rect.x + rect.width / 2, rect.y + 4)
          await expect(dialog).toBeVisible()
          await page.keyboard.press('Tab')
          expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true)
          if (cycle === 0) await page.screenshot({ path: info.outputPath(`dialog-${theme}-${width}.png`) })
          await page.keyboard.press('Escape')
          await expect(dialog).not.toBeVisible()
          await expect(page.locator(width === 390 ? '.nav-menu-toggle' : '.nav-more-trigger')).toBeFocused()
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
        await expect(page.locator('html')).toBeVisible()
      })
    }
  })
}

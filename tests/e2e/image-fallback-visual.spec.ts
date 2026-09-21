import { expect, test, type Locator } from '@playwright/test'
import { textContrast } from './helpers/contrast'

async function readable(text: Locator) {
  await expect(text).toBeVisible()
  await text.evaluate(async element => {
    const animations: Animation[] = []
    for (let node: Element | null = element; node; node = node.parentElement) {
      animations.push(...node.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity))
    }
    await Promise.all(animations.map(a => a.finished.catch(() => undefined)))
  })
  expect(await text.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
}

const sizes = [
  { name: 'desktop', width: 1440, height: 960, scale: 1 },
  { name: '4k150', width: 2560, height: 1440, scale: 1.5 },
  { name: 'phone', width: 390, height: 844, scale: 1 },
]

for (const size of sizes) {
  test.describe(size.name, () => {
    test.use({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale })
    for (const theme of ['dark', 'light']) {
      test(`fallback text and layout ${theme}`, async ({ page }, info) => {
        await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.route('**/assets/characters/*-home-cg-1024.webp', route => route.fulfill({ status: 404, body: 'missing hero' }))
        await page.goto('/', { waitUntil: 'domcontentloaded' })
        const hero = page.locator('.hero-fallback.nene.is-current')
        await hero.scrollIntoViewIfNeeded()
        await readable(hero.locator('.hero-fallback-text'))
        await page.screenshot({ path: info.outputPath(`home-${size.name}-${theme}.png`) })

        const mainPattern = '**/assets/characters/popular-frieren.png*'
        await page.route(mainPattern, route => route.fulfill({ status: 404, body: 'missing portrait' }))
        await page.goto('/character?character=frieren', { waitUntil: 'domcontentloaded' })
        const portrait = page.locator('.portrait[data-portrait-state]')
        await expect(portrait).toHaveAttribute('data-portrait-state', 'fallback')
        // 角色档案默认展示粒子展台；切到原画模式后再验收原图/缩略图回退文案。
        await page.getByRole('button', { name: '人物原画', exact: true }).click()
        await expect(portrait).toBeVisible()
        const note = portrait.locator('.portrait-fallback-note')
        await note.scrollIntoViewIfNeeded()
        await expect(portrait.locator('img')).not.toHaveJSProperty('naturalWidth', 0)
        await readable(note)
        const source = portrait.locator('.portrait-source')
        const noteBox = await note.boundingBox(), sourceBox = await source.boundingBox()
        expect(noteBox && sourceBox).toBeTruthy()
        if (noteBox && sourceBox) {
          const overlapWidth = Math.min(noteBox.x + noteBox.width, sourceBox.x + sourceBox.width) - Math.max(noteBox.x, sourceBox.x)
          const overlapHeight = Math.min(noteBox.y + noteBox.height, sourceBox.y + sourceBox.height) - Math.max(noteBox.y, sourceBox.y)
          expect(overlapWidth <= 0 || overlapHeight <= 0).toBe(true)
        }
        await portrait.screenshot({ path: info.outputPath(`portrait-fallback-${size.name}-${theme}.png`) })

        await page.route('**/assets/characters/thumbs/popular-frieren.webp*', route => route.fulfill({ status: 404, body: 'missing thumbnail' }))
        await page.reload({ waitUntil: 'domcontentloaded' })
        await expect(portrait).toHaveAttribute('data-portrait-state', 'missing')
        await page.getByRole('button', { name: '人物原画', exact: true }).click()
        await expect(portrait).toBeVisible()
        await portrait.scrollIntoViewIfNeeded()
        await readable(portrait.locator('.portrait-missing-title'))
        await readable(portrait.locator('.portrait-missing-text'))
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
        await portrait.screenshot({ path: info.outputPath(`portrait-missing-${size.name}-${theme}.png`) })
      })
    }
  })
}

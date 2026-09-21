import { test, expect } from '@playwright/test'
import sharp from 'sharp'
import MOCK_PORTS from '../../scripts/lib/e2e-ports.js'
import { readdirSync } from 'node:fs'
import { textContrast } from './helpers/contrast'

test.use({ baseURL: `http://127.0.0.1:${MOCK_PORTS.gateway}` })

function luminance(rgb: number[]) {
  return rgb.map(value => { const n = value / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4 })
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
}

const documents = ['index', 'getting-started', 'roadmap',
  ...['art-direction', 'philosophy', 'worldview', 'quality-standard'].map(x => `guides/art/${x}`),
  'guides/characters/scene-spec', 'guides/prompts/prompt-spec', 'guides/prompts/tag-standard',
  'guides/engineering/page-template']

for (const theme of ['dark', 'light']) for (const width of [1440, 390, 320]) {
  test(`document reading and keyboard ${theme} ${width}`, async ({ page }, testInfo) => {
    test.setTimeout(120000)
    await page.setViewportSize({ width, height: 900 })
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    for (const documentPath of documents) {
      await page.goto(`/docs/${documentPath}.html`)
      await expect(page.locator('main')).toHaveCount(1)
      await expect(page.locator('main h1')).toHaveCount(1)
      const base = await page.locator('body').evaluate(el => getComputedStyle(el).getPropertyValue('--bg-base').trim())
      expect(base.toLowerCase()).toBe(theme === 'light' ? '#fff8f4' : '#211c30')
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      await page.keyboard.press('Tab')
      await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(page.locator('main')).toBeFocused()
      const paragraph = page.locator('main p').first()
      await page.screenshot({ path: testInfo.outputPath(`${documentPath.replaceAll('/', '-')}-${theme}-${width}.png`) })
      const color = await paragraph.evaluate(el => getComputedStyle(el).color)
      const foreground = luminance(color.match(/[\d.]+/g)!.slice(0, 3).map(Number))
      const original = await paragraph.getAttribute('style')
      await paragraph.evaluate(el => (el as HTMLElement).style.setProperty('-webkit-text-fill-color', 'transparent', 'important'))
      const { data, info } = await sharp(await paragraph.screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      await paragraph.evaluate((el, value) => value === null ? el.removeAttribute('style') : el.setAttribute('style', value), original)
      let contrast = Infinity
      for (let i = 0; i < data.length; i += info.channels) {
        const background = luminance([...data.subarray(i, i + 3)])
        contrast = Math.min(contrast, (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05))
      }
      expect(contrast, documentPath + ' subtitle against sampled background').toBeGreaterThanOrEqual(4.5)
    }
  })
}

test('document theme survives navigation, synchronizes tabs and menu Escape restores focus', async ({ page, context }) => {
  await page.goto('/docs/index.html')
  const other = await context.newPage()
  await other.goto('/docs/getting-started.html')
  await page.getByRole('button', { name: '切换到浅色主题' }).click()
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.goto('/docs/guides/art/philosophy.html')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  const more = page.getByLabel('打开更多页面')
  await more.click()
  await page.keyboard.press('Escape')
  await expect(more).toBeFocused()
  await expect(page.locator('.nav-more')).not.toHaveAttribute('open', '')
})

test('companion chat main receives keyboard skip without losing log or composer', async ({ page }) => {
  await page.goto('/companion-chat')
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeAttached()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('main')).toBeFocused()
  await expect(page.getByRole('log')).toBeVisible()
  await expect(page.locator('.companion-chat-composer')).toBeVisible()
})

test('archived reports and research remain readable at their existing URLs', async ({ page }, testInfo) => {
  const files = readdirSync('docs/archive/audits').filter(file => file.endsWith('.html'))
    .map(file => `/docs/archive/audits/${file}`)
  files.push('/docs/research/prompts/arknights-artists-research-2026-08-31.html')
  for (const file of files) {
    const response = await page.goto(file)
    expect(response!.status()).toBe(200)
    await expect(page.locator('h1').first()).toBeVisible()
    const observations = await page.evaluate(() => ({ title: document.title,
      headings: [...document.querySelectorAll('h1,h2')].map(el => el.textContent),
      width: document.documentElement.scrollWidth, viewport: innerWidth }))
    await testInfo.attach(file.split('/').pop()!, { body: JSON.stringify(observations), contentType: 'application/json' })
  }
})

for (const theme of ['dark', 'light']) test(`document enlarged reading, score labels and forced colors ${theme}`, async ({ page }) => {
  await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
  await page.setViewportSize({ width: 640, height: 900 })
  for (const documentPath of ['guides/art/quality-standard', 'guides/prompts/tag-standard', 'guides/prompts/prompt-spec']) {
    await page.goto(`/docs/${documentPath}.html`)
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    for (const label of await page.locator('.quality-fill span').all()) {
      expect(await label.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
    }
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' })
    await expect(page.getByRole('main')).toBeVisible()
    await page.emulateMedia({ forcedColors: 'none' })
  }
})

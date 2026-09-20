import { expect, test } from '@playwright/test'
import { textContrast } from './helpers/contrast'

for (const theme of ['dark', 'light']) {
  test(`colour codes stay readable on every palette ${theme}`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/color-script')
    for (const name of ['快乐', '恋爱', '平静', '忧伤', '神秘', '温馨']) {
      await page.getByRole('button', { name: new RegExp(name) }).click()
      await expect(page.locator('.palette-code')).toHaveCount(5)
      for (const code of await page.locator('.palette-code').all()) {
        expect(await code.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
        expect(await code.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12)
      }
    }
  })

  for (const width of [1440, 1280, 390]) {
    test(`artbook references keep selection and layout ${theme} ${width}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 960 })
      await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.goto('/style')
      await expect(page.locator('.style-sample img')).toHaveCount(6)
      await page.locator('.style-sample').last().scrollIntoViewIfNeeded()
      await expect.poll(() => page.locator('.style-sample img').evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true)
      for (const text of await page.locator('.style-card-heading h3, .style-sample-caption, .mood-go').all()) {
        expect(await text.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      await page.evaluate(() => scrollTo(0, 0))
      await page.screenshot({ path: info.outputPath(`style-${theme}-${width}.png`), fullPage: true })
      const calm = page.locator('.style-mood-card').filter({ has: page.getByRole('heading', { name: '平静', exact: true }) })
      await expect(calm.getByRole('link', { name: '查看平静氛围参考' })).toHaveAttribute('href', '/showcase?scene=sc004')
      await calm.getByRole('link', { name: '用这个调子绘制' }).click()
      await expect(page).toHaveURL(/\/prompt-builder\?mood=calm$/)
      const characters = page.getByRole('group', { name: '工作室角色', exact: true })
      await characters.getByRole('button', { name: '夏目', exact: true }).focus()
      await page.keyboard.press('Enter')
      await expect(characters.getByRole('button', { name: '夏目', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.pb')).toHaveAttribute('data-character', 'natsume')
      await characters.getByRole('button', { name: '双人', exact: true }).click()
      await expect(characters.getByRole('button', { name: '双人', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.pb')).toHaveAttribute('data-character', 'triad')
      await characters.getByRole('button', { name: '宁宁', exact: true }).click()
      await expect(page.locator('.pb')).toHaveAttribute('data-character', 'nene')
      await expect(characters.locator('.character-portrait img')).toHaveCount(4)
      for (const text of await characters.locator('.studio-character-copy strong, .studio-character-copy small').all()) {
        expect(await text.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
      }
      await expect(page.locator('.inspector-route')).not.toHaveAttribute('open', '')
      await expect(page.locator('.inspector-voice')).not.toHaveAttribute('open', '')
      await page.locator('#promptMonitor > summary').click()
      await expect(page.locator('#promptMonitor .prompt-health-body')).toBeVisible()
      await page.locator('#promptMonitor > summary').click()
      await page.evaluate(() => scrollTo(0, 0))
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      await page.screenshot({ path: info.outputPath(`director-${theme}-${width}.png`), fullPage: false })
    })
  }
}

test('unrated, adult and ambiguous mood references stay unpublished', async ({ page }) => {
  const entry = (id: string, rating?: string) => ({ id, title: id, char: 'nene', rating, type: 'scene' })
  await page.route('**/scene-showcase/manifest.json', route => route.fulfill({ json: { entries: [
    entry('sc003', 'All'), entry('sc003', 'R18'), entry('sc002', 'R18'), entry('sc004'),
    entry('sc007', 'R15'), entry('sc215', 'unknown'), entry('sc006', 'All'),
  ] } }))
  await page.goto('/style')
  await expect(page.locator('.style-sample img')).toHaveCount(1)
  await expect(page.locator('.style-sample img')).toHaveAttribute('src', '/scene-showcase/thumbs/sc006.jpg')
  await expect(page.locator('.style-sample-missing')).toHaveCount(5)
  await expect(page.getByRole('link', { name: '用这个调子绘制' })).toHaveCount(6)
})

test('offline catalogue and broken portraits leave usable choices', async ({ page }) => {
  await page.route('**/scene-showcase/manifest.json', route => route.fulfill({ status: 503, body: '' }))
  await page.goto('/style')
  await expect(page.getByText('氛围参考暂未连接', { exact: true })).toHaveCount(6)
  await page.getByRole('link', { name: '用这个调子绘制' }).first().click()
  await expect(page).toHaveURL(/mood=joy$/)
  await page.route('**/assets/characters/*-home-cg-512.webp', route => route.fulfill({ status: 404, body: '' }))
  await page.reload()
  const characters = page.getByRole('group', { name: '工作室角色', exact: true })
  await expect(characters.locator('[data-state="placeholder"]')).toHaveCount(4)
  await characters.getByRole('button', { name: '夏目', exact: true }).click()
  await expect(page.locator('.pb')).toHaveAttribute('data-character', 'natsume')
})

test('broken reference image retains its palette and creation link', async ({ page }) => {
  await page.route('**/scene-showcase/thumbs/sc003.jpg', route => route.fulfill({ status: 404, body: '' }))
  await page.goto('/style')
  const joy = page.locator('.style-mood-card').first()
  await expect(joy.getByText('氛围参考暂未连接', { exact: true })).toBeVisible()
  await expect(joy.locator('.mood-swatch')).toHaveCount(5)
  await joy.getByRole('link', { name: '用这个调子绘制' }).click()
  await expect(page).toHaveURL(/mood=joy$/)
})

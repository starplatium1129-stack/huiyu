import { expect, test } from '@playwright/test'
import { pickStudioOptionByValue } from './helpers/studioSelect'

test('theme switch persists through reload and preserves native control colors', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '切换为亮色模式' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('light')
  await page.getByRole('button', { name: '切换为深色模式' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

for (const theme of ['light', 'dark']) {
  test('character browsing is a compact searchable directory in ' + theme, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.goto('/character')
    const directory = page.getByRole('complementary', { name: '角色目录' })
    await expect(directory).toBeVisible()
    await pickStudioOptionByValue(page.getByLabel('筛选角色系列'), 'Oregairu')
    await expect(directory.locator('.directory-item')).toHaveCount(4)
    await pickStudioOptionByValue(page.getByLabel('筛选角色系列'), '')
    await page.getByRole('searchbox', { name: '搜索角色或作品' }).fill('加藤惠')
    await expect(directory.locator('.directory-item')).toHaveCount(1)
    await page.getByRole('searchbox', { name: '搜索角色或作品' }).press('Enter')
    await expect(page.locator('.character-name')).toHaveText('加藤惠')
    await expect(page).toHaveURL(/character=katou_megumi/)
    const left = await directory.boundingBox(), detail = await page.locator('.library-detail').boundingBox()
    expect(detail!.x).toBeGreaterThan(left!.x + left!.width)
  })
  test('updated portrait particles remain visible on the ' + theme + ' surface', async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/popular-scenes?character=shiina_mahiru')
    const field = page.locator('.pop-hero-field')
    await expect(field).toHaveClass(/has-portrait/)
    await expect.poll(() => field.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
      let painted = 0
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 200) painted++
      return painted
    })).toBeGreaterThan(500)
    await expect(page.locator('.library-detail h2').first()).toHaveText('椎名真昼')
    await page.getByRole('searchbox', { name: '搜索角色或作品' }).fill('和栗薰子')
    await page.getByRole('searchbox', { name: '搜索角色或作品' }).press('Enter')
    await expect(page.locator('.library-detail h2').first()).toHaveText('和栗薰子')
    await expect(field).toHaveAttribute('aria-label', /和栗薰子/)
  })
}

test('script selection stays accessible beside the current acts', async ({ page }) => {
  await page.goto('/scenario')
  await expect(page.locator('.scenario-list')).toBeVisible()
  await expect(page.locator('.acts')).toBeVisible()
  const card = page.locator('.scenario-card').nth(1)
  await card.click()
  await expect(card).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.viewer-h2')).toContainText('雨天')
  await expect(page.locator('.scenario-list')).toBeVisible()
})


test('the loading frame honors light mode before application scripts arrive', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('aics_theme', 'light'))
  await page.route('**/_app/*.js', route => route.abort())
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await page.locator('#app').evaluate(el => getComputedStyle(el, '::before').backgroundColor)).toBe('rgb(255, 248, 244)')
})

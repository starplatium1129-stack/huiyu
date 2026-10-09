import { expect, test } from '@playwright/test'
import { pickStudioOptionByValue } from './helpers/studioSelect'
import { textContrast } from './helpers/contrast'

test('theme switch persists through reload and preserves native control colors', async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.addInitScript(() => localStorage.setItem('aics_guest_guide_dismissed', '1'))
  await page.goto('/')
  await page.evaluate(() => {
    const native = document.startViewTransition.bind(document)
    const transitions: ViewTransition[] = []
    const samples: Array<Promise<{ duration: string; name: string }>> = []
    Object.assign(window, { themeTransitions: transitions, themeSamples: samples })
    document.startViewTransition = (...args) => {
      const transition = native(...args)
      transitions.push(transition)
      samples.push(transition.ready.then(() => {
        const style = getComputedStyle(document.documentElement, '::view-transition-new(root)')
        return { duration: style.animationDuration, name: style.animationName }
      }))
      return transition
    }
  })
  await page.getByRole('button', { name: '切换为亮色模式' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  const animation = await page.evaluate(async () => {
    const { themeTransitions: transitions, themeSamples: samples } = window as Window & {
      themeTransitions: ViewTransition[]; themeSamples: Array<Promise<{ duration: string; name: string }>>
    }
    const transition = transitions.at(-1)!
    const result = { count: transitions.length, ...await samples.at(-1)! }
    await transition.finished
    return result
  })
  expect(animation.count).toBe(1)
  expect(parseFloat(animation.duration)).toBeGreaterThan(0)
  expect(parseFloat(animation.duration)).toBeLessThanOrEqual(.3)
  expect(animation.name).not.toBe('none')
  await expect(page.locator('html')).not.toHaveAttribute('data-theme-transition')
  await page.screenshot({ path: info.outputPath('theme-light.png') })
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('light')
  await page.getByRole('button', { name: '切换为深色模式' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('html')).not.toHaveAttribute('data-theme-transition')
  await page.screenshot({ path: info.outputPath('theme-dark.png') })
  await page.evaluate(() => {
    const toggle = document.querySelector<HTMLButtonElement>('.app-theme-toggle')!
    toggle.click(); toggle.click(); toggle.click()
  })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.locator('html')).not.toHaveAttribute('data-theme-transition')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const reduced = await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('.app-theme-toggle')!.click()
    return { theme: document.documentElement.dataset.theme, animated: document.documentElement.hasAttribute('data-theme-transition') }
  })
  expect(reduced).toEqual({ theme: 'dark', animated: false })
})

for (const theme of ['light', 'dark']) {
  test('character browsing is a compact searchable directory in ' + theme, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.goto('/character?character=nene')
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
    await directory.getByRole('button', { name: '清除筛选' }).click()
    await expect(page.getByRole('searchbox', { name: '搜索角色或作品' })).toHaveValue('')
    const left = await directory.boundingBox(), detail = await page.locator('.library-detail').boundingBox()
    expect(detail!.x).toBeGreaterThan(left!.x + left!.width)
  })
  test('updated portrait particles remain visible on the ' + theme + ' surface', async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/character?character=shiina_mahiru')
    const field = page.locator('.particle-theatre .has-portrait')
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

test('the loading frame honors light mode before application scripts arrive', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('aics_theme', 'light'))
  await page.route('**/_app/*.js', route => route.abort())
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  const loadingFrame = page.locator('#app')
  await expect(loadingFrame).not.toHaveAttribute('data-v-app')
  const frame = await loadingFrame.evaluate(element => {
    const style = getComputedStyle(element, '::before')
    return { content: style.content, rgb: style.backgroundColor.match(/[\d.]+/g)!.map(Number) }
  })
  expect(frame.content).toContain('HUIYU')
  // The selected light theme must not flash a dark frame; the palette can evolve.
  expect(Math.min(...frame.rgb.slice(0, 3))).toBeGreaterThan(200)
  expect(await loadingFrame.evaluate(textContrast, '::before')).toBeGreaterThanOrEqual(4.5)
})

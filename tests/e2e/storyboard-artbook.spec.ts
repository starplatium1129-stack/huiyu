import { expect, test, type Page } from '@playwright/test'
import { SCENARIOS, substituteScenarioPrompt } from '../../src/config/scenarios'
import { textContrast } from './helpers/contrast'

async function dismissNotices(page: Page) {
  const buttons = page.locator('.toast-close')
  let count = await buttons.count()
  while (count > 0) {
    await buttons.last().click()
    await expect.poll(() => buttons.count()).toBeLessThan(count)
    count = await buttons.count()
  }
}

async function installVideoFixture(page: Page) {
  const submitted: string[] = []
  await page.route('**/api/video/**', route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/video/status') return route.fulfill({ json: {
      ok: true, online: false, pending: 0, maxPending: 2,
      models: [{ id:'minimax-h3', label:'MiniMax H3', available:true, executable:true, modes:['text','image','first-last-frame'], requirements:[], missing:[] }],
      qualities: [], defaults: { modelId:'minimax-h3' }, t8:{ available:false, reason:'离线编辑测试' },
    } })
    if (url.pathname === '/api/video/images') return route.fulfill({ json: { ok:true, name:'storyboard-fixture.jpg', bytes:4096 } })
    if (route.request().method() !== 'GET') submitted.push(url.pathname)
    return route.fulfill({ json: { ok:true, jobs:[], batches:[] } })
  })
  return submitted
}

for (const theme of ['dark', 'light']) for (const width of [1440, 390]) {
  test(`story notebook preserves prompts and shot handoff ${theme} ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 })
    await page.emulateMedia({ reducedMotion:'reduce' })
    await page.addInitScript(theme => {
      localStorage.setItem('aics_theme', theme)
      Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{ writeText:async (text: string) => { document.documentElement.dataset.copiedPrompt = text } } })
    }, theme)
    const submitted = await installVideoFixture(page)
    await page.goto('/scenario')
    for (const character of ['nene', 'natsume'] as const) {
      await page.getByRole('group', { name:'剧本角色' }).getByRole('button', { name:character === 'nene' ? '宁宁' : '夏目', exact:true }).click()
      await expect(page.locator('.scenario-cover img')).toHaveCount(3)
      await expect(page.locator('.scenario-cover img').first()).toHaveAttribute('src', `/scene-showcase/thumbs/${character === 'nene' ? 'sc001' : 'sc011'}.jpg`)
      for (const [index, scenario] of SCENARIOS.entries()) {
        const card = page.locator('.scenario-card').nth(index)
        await card.focus(); await page.keyboard.press('Enter')
        await expect(card).toHaveAttribute('aria-pressed', 'true')
        await expect(page.locator('.act')).toHaveCount(scenario.acts.length)
        await expect(page.locator('.act-details[open]')).toHaveCount(0)
        for (const [actIndex, act] of scenario.acts.entries()) {
          const copy = page.locator('.act').nth(actIndex).getByRole('button', { name:'复制本幕 Prompt', exact:true })
          await copy.focus(); await page.keyboard.press('Enter')
          const expected = substituteScenarioPrompt(act.prompt, character).split(',').map(value => value.trim().replace(/[\s-]+/g, '_')).join(', ')
          await expect(page.locator('html')).toHaveAttribute('data-copied-prompt', expected)
        }
      }
    }
    await page.locator('.act-details > summary').first().click()
    await expect(page.locator('.prompt-code').first()).toContainText('shiki_natsume')
    await page.locator('.act-details > summary').first().click()
    for (const label of await page.locator('.act-title, .act-desc, .act-format, .act-details > summary').all()) {
      expect(await label.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    await dismissNotices(page)
    await page.evaluate(() => scrollTo(0, 0))
    await page.screenshot({ path: info.outputPath(`scenario-${theme}-${width}.png`), fullPage:true })
    await page.getByRole('button', { name:/送入分镜短片/ }).click()
    await expect(page).toHaveURL(/\/video-studio(?:\?mode=shots)?$/)
    await expect(page.getByRole('button', { name:/分镜短片/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.storyboard-frame')).toHaveCount(3)
    await expect(page.locator('.storyboard-total')).toHaveText('3 镜 · 9 秒')
    const acts = SCENARIOS[2]!.acts
    for (const [index, act] of acts.entries()) {
      await expect(page.locator('.shot-row').nth(index).locator('.shot-field-prompt textarea')).toHaveValue(`${act.desc}。${act.emotion}的氛围。`)
    }
    await page.getByRole('button', { name:'查看镜头 2', exact:true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-shot-index="1"]')).toBeFocused()
    const first = page.locator('.shot-row').first()
    await first.getByRole('combobox', { name:'时长', exact:true }).selectOption('5')
    await expect(page.locator('.storyboard-total')).toHaveText('3 镜 · 11 秒')
    await first.locator('input[type="file"]').setInputFiles('assets/characters/natsume-home-cg-512.webp')
    const overview = page.getByRole('navigation', { name:'镜头首帧总览' })
    await expect(overview.locator('img')).toHaveCount(1)
    await expect(overview.locator('img')).toHaveCSS('object-fit', 'contain')
    await expect.poll(() => overview.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await page.locator('.shot-row').nth(1).getByTitle('上移', { exact:true }).click()
    await expect(page.locator('.storyboard-frame').first()).toContainText(acts[1]!.desc)
    await expect(page.locator('.storyboard-frame').nth(1).locator('img')).toHaveCount(1)
    await expect(page.locator('.storyboard-frame').nth(1)).toContainText('5 秒')
    for (const label of await overview.locator('.storyboard-caption, .storyboard-description').all()) expect(await label.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
    await dismissNotices(page)
    await overview.scrollIntoViewIfNeeded()
    await overview.screenshot({ path:info.outputPath(`storyboard-${theme}-${width}.png`) })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    expect(submitted).toEqual([])
  })
}

test('unavailable covers keep every story and act usable', async ({ page }) => {
  await page.route('**/scene-showcase/manifest.json', route => route.fulfill({ status:503 }))
  await page.goto('/scenario')
  await expect(page.getByText('氛围参考暂未连接', { exact:true })).toHaveCount(3)
  await page.locator('.scenario-card').nth(1).click()
  await expect(page.locator('.act')).toHaveCount(3)
  await expect(page.locator('.viewer-h2')).toContainText('雨天的共伞')
})

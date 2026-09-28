import { expect, test, type Page } from '@playwright/test'

// CSS viewports at DPR 1; operating-system DPI is covered by separate device acceptance.
test.use({ deviceScaleFactor: 1 })

const catalog = [
  { id: 'L_NENE_V18_WD14', name: 'ayachi_nene_v18_wd14', character: 'NENE_001', base_model: 'waiIllustriousSDXL_v170', description: '宁宁历史模型资料', trigger: 'ayachi_nene' },
  { id: 'L_NAT_V21_ANIMA', name: 'shiki_natsume_v21_anima', character: 'NATSUME_001', base_model: 'anima-base-v1.0', description: '夏目角色模型完整说明', trigger: 'shiki_natsume', recommended_weight: 0.85,
    validation: { status: 'passed', evaluated_at: '2026-08-13', method: '历史固定种子复核', evidence: 'reports/fixture.md', metrics: { 角色身份: '历史样本通过' } } },
  // A familiar file name must never create a launch mapping for an unknown ID.
  { id: 'UNMAPPED_FIXTURE', name: 'ayachi_nene_unknown', character: 'unknown', base_model: 'unverified', description: '未登记的参考资料', trigger: 'fixture' },
]

async function prepare(page: Page, theme: string) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
  await page.route('**/data/loras.json?*', route => route.fulfill({ json: catalog }))
  await page.route('**/scene-showcase/manifest.json', route => route.fulfill({ json: { entries: [] } }))
}

for (const theme of ['light', 'dark']) {
  for (const [width, height] of [[1920, 1080], [2560, 1440], [3840, 2160]]) {
    test(`creative library keeps its navigation frame ${theme} ${width}`, async ({ page }, info) => {
      await prepare(page, theme)
      await page.setViewportSize({ width, height })
      await page.goto('/style')
      const routes = [
        { label: '画风与氛围', path: '/style', heading: '画风', content: '.style-mood-card' },
        { label: '色彩情绪', path: '/color-script', heading: '色彩情绪', content: '.mood-card' },
        { label: '模型资料', path: '/lora', heading: '模型资料 (LoRA)', content: '.lora-card' },
        { label: '剧本与分幕', path: '/scenario', heading: '剧本模式', content: '.scenario-card' },
      ]
      let baseline: { x: number; y: number; width: number; height: number } | undefined
      for (const route of routes) {
        await page.getByRole('navigation', { name: '创作资料导航', exact: true }).getByRole('link', { name: route.label, exact: true }).click()
        await expect(page).toHaveURL(new RegExp(`${route.path}$`))
        await expect(page.getByRole('heading', { name: route.heading, exact: true })).toBeVisible()
        const current = page.locator('.creative-library-page:visible:not([inert])')
        await expect(current.locator(route.content).first()).toBeVisible()
        await page.evaluate(() => document.fonts.ready)
        const navigation = current.getByRole('navigation', { name: '创作资料导航', exact: true })
        await expect(navigation.getByRole('link', { name: route.label, exact: true })).toHaveAttribute('aria-current', 'page')
        const box = (await navigation.boundingBox())!
        if (!baseline) baseline = box
        for (const key of ['x', 'y', 'width', 'height'] as const) {
          expect(Math.abs(box[key] - baseline[key]), `${route.path} navigation ${key}`).toBeLessThanOrEqual(1)
        }
        await expect(current.locator(route.content).first()).toBeInViewport({ ratio: 1 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
        await page.screenshot({ path: info.outputPath(`${route.path.slice(1)}.png`) })
      }
    })
  }

  test(`palette applies before optional notebook reading ${theme}`, async ({ page }) => {
    await prepare(page, theme)
    await page.goto('/color-script')
    const reading = page.locator('.color-reading')
    await expect(reading).not.toHaveAttribute('open', '')
    await expect(page.locator('.light-notebook')).toBeHidden()
    const calm = page.locator('.mood-card[data-mood="calm"]')
    await expect(calm).toBeInViewport({ ratio: 1 })
    await calm.click()
    const apply = page.getByRole('link', { name: '带入工作台使用', exact: true })
    await expect(apply).toHaveAttribute('href', '/prompt-builder?mood=calm')
    await expect(apply).toBeInViewport({ ratio: 1 })
    await apply.click({ trial: true })
    await reading.locator(':scope > summary').focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('.light-notebook')).toBeVisible()
    await page.locator('.study-mood').first().click()
    await expect(page.locator('.result-panel')).toBeFocused()
    await expect(apply).toHaveAttribute('href', '/prompt-builder?mood=joy')
    await page.getByRole('button', { name: '换一个情绪', exact: true }).click()
    await expect(page.locator('.mood-card[data-mood="joy"]')).toBeFocused()
    await calm.click()
    await apply.click()
    await expect(page).toHaveURL(/\/prompt-builder\?mood=calm$/)
  })

  test(`model actions preserve availability boundaries and disclose history on demand ${theme}`, async ({ page }) => {
    await prepare(page, theme)
    await page.goto('/lora')
    await expect(page.locator('.lora-card')).toHaveCount(3)
    const current = page.locator('.lora-card').first()
    await expect(current.getByRole('heading', { name: '四季夏目', exact: true })).toBeVisible()
    await expect(current.locator('.model-engine')).toHaveText('Anima')
    await expect(current.locator('.model-availability')).toContainText('本机可用性尚未检测。入口只选择角色，不强制加载此历史版本')
    await expect(page.locator('.model-catalog-note')).toContainText('历史评测通过，均不代表本机已安装')
    const launch = current.getByRole('link', { name: '用此角色绘制', exact: true })
    await expect(launch).toHaveAttribute('href', '/prompt-builder?char=natsume')
    await expect(launch).toBeInViewport({ ratio: 1 })
    await expect(current.locator('.evaluation-metrics')).toBeHidden()
    const disclosure = current.locator('.evaluation-panel summary')
    expect((await launch.boundingBox())!.y).toBeLessThan((await disclosure.boundingBox())!.y)
    await disclosure.click()
    await expect(current.locator('.evaluation-metrics')).toBeVisible()
    await expect(current.locator('.evaluation-panel')).toContainText('历史固定种子复核')
    await current.locator('.model-details > summary').click()
    await expect(current.locator('.model-details')).toContainText('夏目角色模型完整说明')
    await expect(page.locator('.lora-card').filter({ hasText: 'ayachi_nene_unknown' }).getByRole('link')).toHaveCount(0)
    await page.getByRole('searchbox', { name: '搜索模型', exact: true }).fill('四季夏目')
    await expect(page.locator('.lora-card')).toHaveCount(1)
    await launch.click()
    await expect(page).toHaveURL(/\/prompt-builder\?char=natsume$/)
  })
}

import { expect, test, type Locator, type Page } from '@playwright/test'
import { installSceneStateFixture } from './helpers/sceneState'
import { installShowcaseFixture } from './helpers/showcase'

type Theme = 'light' | 'dark'

async function prepare(page: Page, theme: Theme, width: number) {
  await page.setViewportSize({ width, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme })
  await page.addInitScript(value => {
    localStorage.setItem('aics_theme', value)
    localStorage.setItem('aics_guest_guide_dismissed', '1')
    localStorage.setItem('aics_pb_director_mode', 'basic')
  }, theme)
  // This suite uses the configured mock stack; capability changes must not hide
  // the controls being measured, and no generation job is submitted.
  await page.route('**/api/generation/status', route => route.fulfill({ json: {
    ok: true, online: true, provider: 'webui', webuiOnline: true, comfyFallbackOnline: false,
    checkpoint: 'layout-fixture.safetensors', models: [], loras: [],
    samplers: ['Euler a'], schedulers: ['Normal'], pending: 0, maxPending: 4,
    capabilities: { basic: true, hires: true, faceDetailer: false, hiresUpscalers: ['Latent'] },
  } }))
}

async function openExpert(page: Page) {
  await page.goto('/prompt-builder')
  await page.getByRole('button', { name: '专家模式', exact: true }).click()
  await expect(page.locator('.pb')).toHaveAttribute('data-director-mode', 'pro')
  await expect(page.locator('.engine-switch .engine-btn')).toHaveCount(3)
  await page.evaluate(() => document.fonts.ready)
}

async function expectInsideScrollWidth(scroll: Locator, contents: Locator) {
  const viewport = await scroll.evaluate(element => {
    const box = element.getBoundingClientRect()
    return { left: box.left + element.clientLeft, right: box.left + element.clientLeft + element.clientWidth }
  })
  for (const element of await contents.all()) {
    const box = (await element.boundingBox())!
    expect(box.x, 'control left edge stays inside the inspector').toBeGreaterThanOrEqual(viewport.left - 1)
    expect(box.x + box.width, 'control right edge stays inside the inspector').toBeLessThanOrEqual(viewport.right + 1)
  }
  expect(await scroll.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
}

async function inspectorGeometry(page: Page, panel: 'render' | 'prompt') {
  await page.locator(`#inspector-tab-${panel}`).click()
  await expect(page.locator(`#inspector-${panel} .panel-title`).first()).toBeVisible()
  return page.locator('.director-inspector').evaluate((inspector, panel) => {
    const root = inspector.getBoundingClientRect()
    const tabs = inspector.querySelector('.inspector-tabs')!
    const tabBox = tabs.getBoundingClientRect()
    const tabStyle = getComputedStyle(tabs)
    const scroll = inspector.querySelector(`#inspector-${panel}`)!
    const scrollBox = scroll.getBoundingClientRect()
    const section = inspector.querySelector(`#inspector-${panel}`)!
    const sectionBox = section.getBoundingClientRect()
    const headerBox = section.querySelector('.panel-title')!.getBoundingClientRect()
    return {
      tabsLeft: tabBox.left - root.left, tabsTop: tabBox.top - root.top,
      tabsWidth: tabBox.width, tabsHeight: tabBox.height,
      tabsMarginTop: parseFloat(tabStyle.marginTop), tabsMarginRight: parseFloat(tabStyle.marginRight),
      tabsMarginBottom: parseFloat(tabStyle.marginBottom), tabsMarginLeft: parseFloat(tabStyle.marginLeft),
      sectionLeft: sectionBox.left - scrollBox.left,
      sectionTop: sectionBox.top - scrollBox.top + scroll.scrollTop,
      sectionWidth: sectionBox.width,
      headerLeft: headerBox.left - sectionBox.left, headerTop: headerBox.top - sectionBox.top,
      headerWidth: headerBox.width, headerHeight: headerBox.height,
    }
  }, panel)
}

for (const theme of ['light', 'dark'] as const) {
  test(`gallery SPA navigation keeps reference metadata beside the image ${theme}`, async ({ page }, info) => {
    await prepare(page, theme, 1440)
    await installShowcaseFixture(page)
    await page.goto('/gallery')
    const documentOrigin = await page.evaluate(() => performance.timeOrigin)
    await page.getByRole('navigation', { name: '主导航', exact: true })
      .getByRole('link', { name: '参考画册', exact: true }).click()
    await expect(page).toHaveURL(/\/showcase$/)
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentOrigin)
    await page.locator('.sample-visual').first().click()
    const viewer = page.locator('.showcase-viewer')
    await expect(viewer).toBeVisible()
    const copy = (await viewer.locator('.viewer-copy').boundingBox())!
    const position = (await viewer.locator('.viewer-position').boundingBox())!
    expect(position.x).toBeGreaterThanOrEqual(copy.x)
    expect(position.x + position.width).toBeLessThanOrEqual(copy.x + copy.width)
    expect(position.y).toBeGreaterThan(copy.y)
    await viewer.screenshot({ path: info.outputPath('reference-after-gallery.png') })
  })

  for (const width of [1440, 1024]) {
    test(`engine cards fill the inspector row ${theme} ${width}`, async ({ page }, info) => {
      await prepare(page, theme, width)
      await openExpert(page)
      const group = page.getByRole('group', { name: '出图引擎', exact: true })
      await group.scrollIntoViewIfNeeded()
      const row = (await group.boundingBox())!
      // Tooltip anchors introduce a wrapper; measure the visible buttons rather
      // than assuming their parent grid tracks also size the button itself.
      const buttons = await group.locator('.engine-btn').all()
      const first = (await buttons[0].boundingBox())!
      expect(Math.abs(first.x - row.x)).toBeLessThanOrEqual(1)
      for (const button of buttons) {
        const box = (await button.boundingBox())!
        expect(Math.abs(box.y - row.y)).toBeLessThanOrEqual(1)
        expect(Math.abs(box.width - first.width)).toBeLessThanOrEqual(1)
      }
      const last = (await buttons.at(-1)!.boundingBox())!
      expect(Math.abs(last.x + last.width - row.x - row.width)).toBeLessThanOrEqual(1)
      await expectInsideScrollWidth(page.locator('.inspector-scroll:visible'), group)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      await group.screenshot({ path: info.outputPath('engine-cards.png') })
    })

    test(`hires advanced controls remain reachable inside the inspector ${theme} ${width}`, async ({ page }, info) => {
      await prepare(page, theme, width)
      await openExpert(page)
      await page.locator('.engine-btn').filter({ hasText: 'SD 引擎' }).click()
      const hires = page.getByRole('switch', { name: 'hires.fix', exact: true })
      await expect(hires).toHaveAttribute('aria-checked', 'false')
      await hires.click()
      await expect(hires).toHaveAttribute('aria-checked', 'true')
      await page.locator('.sd-advanced-options > summary').click()
      const grid = page.locator('.sd-advanced-grid')
      await expect(grid).toBeVisible()
      const scroll = page.locator('.inspector-scroll:visible')
      const steps = grid.getByRole('spinbutton', { name: '二阶段步数', exact: true })
      const denoise = grid.getByRole('spinbutton', { name: '重绘幅度', exact: true })
      for (const [input, value] of [[steps, '24'], [denoise, '0.45']] as const) {
        // Real clicks exercise clipping and automatic scrolling; force clicks
        // or programmatic focus would miss the original inaccessible popup.
        await input.click()
        await expect(input).toBeFocused()
        // Fractional CSS pixels at the rail's clip edge can hide less than 1%.
        await expect(input).toBeInViewport({ ratio: 0.99 })
        await input.fill(value)
        await input.press('Tab')
        await expect(input).toHaveValue(value)
      }
      const upscaler = grid.getByRole('combobox', { name: '放大器', exact: true })
      await upscaler.click()
      await page.getByRole('option', { name: 'R-ESRGAN 4x+ Anime6B', exact: true }).click()
      await expect(upscaler).toContainText('R-ESRGAN 4x+ Anime6B')
      await expectInsideScrollWidth(scroll, page.locator('.sd-advanced-grid, .sd-advanced-grid input, .sd-advanced-grid .studio-select-trigger'))
      expect(await scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      await grid.screenshot({ path: info.outputPath('hires-advanced.png') })
    })
  }

  test(`maintenance SPA navigation preserves inspector geometry ${theme}`, async ({ page }) => {
    await prepare(page, theme, 1440)
    await installSceneStateFixture(page)
    await openExpert(page)
    const before = {
      render: await inspectorGeometry(page, 'render'),
      prompt: await inspectorGeometry(page, 'prompt'),
    }
    const documentOrigin = await page.evaluate(() => performance.timeOrigin)
    await page.getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('dialog', { name: '更多页面', exact: true })
      .getByRole('link', { name: '场景管理', exact: true }).click()
    await expect(page).toHaveURL(/\/scene-manager$/)
    await expect(page.locator('.manager-workspace')).toBeVisible()
    await expect(page.locator('#maintenanceTitle')).toHaveText('已同步')
    // Navigate through the actual RouterLink. Reloading would unload the
    // maintenance stylesheet and hide the cross-route selector regression.
    await page.getByRole('navigation', { name: '主导航', exact: true })
      .getByRole('link', { name: '绘制', exact: true }).click()
    await expect(page).toHaveURL(/\/prompt-builder$/)
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentOrigin)
    await expect(page.locator('.pb')).toHaveAttribute('data-director-mode', 'pro')
    for (const panel of ['render', 'prompt'] as const) {
      const after = await inspectorGeometry(page, panel)
      for (const key of Object.keys(before[panel]) as Array<keyof typeof after>) {
        expect(Math.abs(after[key] - before[panel][key]), `${panel}: ${key} after maintenance`).toBeLessThanOrEqual(1)
      }
    }
  })
}

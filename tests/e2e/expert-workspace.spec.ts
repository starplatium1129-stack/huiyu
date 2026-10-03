import { expect, test } from '@playwright/test'

for (const [width, height, theme] of [[1440, 900, 'dark'], [1280, 800, 'light']] as const) {
  test(`expert workspace keeps canvas visible while adjusting parameters ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.goto('/prompt-builder')
    await page.getByRole('button', { name: '专家模式', exact: true }).click()
    const inspector = page.getByRole('complementary', { name: '创作参数' })
    await expect(inspector).toBeVisible()
    const canvas = await page.locator('.stage-slot').boundingBox()
    const action = await page.locator('.gen-bar').boundingBox()
    const rail = await inspector.boundingBox()
    await expect(page.locator('#drawing-materials')).toBeVisible()
    const materials = (await page.locator('#drawing-materials').boundingBox())!
    expect(canvas!.width).toBeGreaterThan(materials.width)
    expect(canvas!.width).toBeGreaterThan(400)
    expect(canvas!.width).toBeGreaterThan(rail!.width)
    expect(rail!.x).toBeGreaterThan(canvas!.x + canvas!.width)
    expect(action!.y + action!.height).toBeLessThanOrEqual(height)
    await page.locator('.engine-switch button').first().click()
    await page.locator('.inspector-advanced > summary').click()
    const cfg = page.locator('.ctrl-num').first()
    await cfg.fill('8')
    await cfg.blur()
    await page.locator('.artist-picker-trigger').click()
    await expect(page.getByRole('dialog', { name: '画师风格', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '关闭画师选择', exact: true }).click()
    await page.getByRole('tab', { name: '提示词', exact: true }).click()
    await expect(page.locator('#promptMonitor')).toBeVisible()
    await page.getByRole('tab', { name: '生成', exact: true }).click()
    await expect(cfg).toHaveValue('8')
    await page.locator('[aria-controls="material-story"]').click()
    await expect(inspector).toBeVisible()
    await page.locator('[aria-controls="material-character"]').click()
    await expect(cfg).toHaveValue('8')
    expect((await page.locator('.stage-slot').boundingBox())!.y).toBeCloseTo(canvas!.y, 0)
    await page.getByRole('tab', { name: '生成', exact: true }).focus()
    await page.keyboard.press('End')
    await expect(page.getByRole('tab', { name: '任务', exact: true })).toBeFocused()
    await expect(page.locator('.inspector-delivery')).toBeVisible()
    await page.getByRole('button', { name: '进入专注成片模式' }).click()
    await expect(inspector).toBeHidden()
    await expect(page.locator('.gen-bar')).toBeVisible()
    await expect(page.getByRole('button', { name: '生成图片', exact: true })).toBeInViewport({ ratio: 1 })
    expect((await page.locator('.stage-slot').boundingBox())!.width).toBeGreaterThan(canvas!.width)
    await page.getByRole('button', { name: '退出专注成片模式' }).click()
    await expect(page.getByRole('tab', { name: '任务', exact: true })).toHaveAttribute('aria-selected', 'true')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  })
}

test('a portrait result fits the canvas and keeps generation and save actions reachable', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.route('**/api/generation/status', route => route.fulfill({ json: {
    ok: true, online: true, provider: 'webui', webuiOnline: true, comfyFallbackOnline: false, models: [], loras: [], pending: 0, maxPending: 4,
    checkpoint: 'waiIllustriousSDXL_v170.safetensors', samplers: ['Euler a'], schedulers: ['Normal'],
    capabilities: { basic: true, hires: false, faceDetailer: false, hiresUpscalers: [] },
  } }))
  await page.route('**/api/generation/jobs', route => route.fulfill({ json: { ok: true, job: {
    id: 'layout-fixture', status: 'succeeded', provider: 'webui', seed: 42,
    resultUrl: '/layout-fixture.png', resultAvailable: true, metadata: { seed: 42 },
  } } }))
  await page.route('**/layout-fixture.png', route => route.fulfill({ contentType: 'image/png', path: 'assets/characters/popular-katou_megumi.png' }))
  await page.goto('/prompt-builder?scene=sc001')
  await page.getByRole('button', { name: '专家模式', exact: true }).click()
  await page.locator('.engine-switch button').first().click()
  await page.getByTestId('sd-generate').click()
  await expect(page.locator('.result-image')).toBeVisible()
  await expect(page.locator('.stage-placeholder')).toHaveCount(0)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const result = await page.locator('.result-image-wrap').boundingBox()
  const canvas = await page.locator('#drawing-canvas').boundingBox()
  const action = await page.locator('.gen-bar').boundingBox()
  expect(result!.y + result!.height).toBeLessThan(action!.y + 1)
  expect(action!.y + action!.height).toBeLessThanOrEqual(900)
  expect(result!.y + result!.height).toBeLessThanOrEqual(canvas!.y + canvas!.height + 1)
  expect(result!.y + result!.height).toBeLessThanOrEqual(900)
  const image = (await page.locator('.result-image-reveal').boundingBox())!
  const resultActions = (await page.locator('.result-image-actions').boundingBox())!
  expect(image.y + image.height).toBeLessThanOrEqual(resultActions.y + 1)
  await expect(page.getByRole('button', { name: '生成图片', exact: true })).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('button', { name: '存入作品册', exact: true })).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: 'runtime/expert-result-verified.png' })
})

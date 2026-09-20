import { expect, test, type Page } from '@playwright/test'
import { textContrast } from './helpers/contrast'

async function prepare(page: Page, theme: string, online = false) {
  await page.route(/^http:\/\/[^/]+\/api\//, route => route.fulfill({ json: { ok: true, online: false, models: [], loras: [], styleLoras: [] } }))
  await page.route('**/api/generation/status', route => route.fulfill({ json: {
    ok: true, online, provider: online ? 'webui' : null, webuiOnline: online, comfyFallbackOnline: false,
    models: [], loras: [], pending: 0, maxPending: 4, checkpoint: 'fixture.safetensors', samplers: ['Euler a'], schedulers: ['Normal'],
    capabilities: { basic: online, hires: false, faceDetailer: false, hiresUpscalers: [] },
  } }))
  await page.addInitScript(theme => {
    localStorage.setItem('aics_theme', theme)
    localStorage.setItem('aics_pb_director_mode', 'basic')
    localStorage.setItem('aics_draw_engine', 'sd')
  }, theme)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/prompt-builder?scene=sc001')
  await expect(page.locator('.material-drawer')).toBeVisible()
  await expect(page.locator('.director-inspector')).toBeVisible()
  await expect(page.locator('.stage-placeholder')).toBeVisible()
}

for (const theme of ['light', 'dark']) {
  test(`atelier panels preserve drafts and focus mode ${theme}`, async ({ page }, testInfo) => {
    await prepare(page, theme)
    await expect(page.locator('.gen-bar-actions .btn-primary')).toBeDisabled()
    await expect(page.locator('.gen-bar-blocked')).not.toBeEmpty()
    const canvas = (await page.locator('.col-center').boundingBox())!
    const rail = (await page.locator('.director-inspector').boundingBox())!
    expect(rail.x).toBeGreaterThanOrEqual(canvas.x + canvas.width)
    expect((await page.locator('.gen-bar').boundingBox())!.height).toBeLessThanOrEqual(80)
    for (const selector of ['.atelier-kicker', '.stage-placeholder-title', '.stage-placeholder-copy', '.gen-bar-blocked', '.inspector-heading strong']) {
      expect(await page.locator(selector).evaluate(textContrast), selector).toBeGreaterThanOrEqual(4.5)
    }
    await page.screenshot({ path: testInfo.outputPath(`workbench-${theme}-basic.png`) })
    await page.locator('[aria-controls="material-story"]').click()
    await page.locator('.story-input').fill('安静的午后，窗边的咖啡与一本打开的书。')
    await page.locator('[aria-controls="material-character"]').click()
    await page.locator('[aria-controls="material-story"]').click()
    await expect(page.locator('.story-input')).toHaveValue('安静的午后，窗边的咖啡与一本打开的书。')
    await page.getByRole('button', { name: '专家模式', exact: true }).click()
    await page.getByRole('tab', { name: '提示词', exact: true }).click()
    await expect(page.locator('#promptMonitor')).toBeVisible()
    await page.getByRole('tab', { name: '生成', exact: true }).click()
    await page.screenshot({ path: testInfo.outputPath(`workbench-${theme}-expert.png`) })
    await page.getByRole('button', { name: '进入专注成片模式' }).click()
    await expect(page.locator('.director-inspector')).toBeHidden()
    await expect(page.locator('#drawing-materials')).toBeHidden()
    await expect(page.locator('.gen-bar')).toBeVisible()
    await page.getByRole('button', { name: '退出专注成片模式' }).click()
    await expect(page.locator('.director-inspector')).toBeVisible()
  })

  test(`atelier mocked generation states and saving ${theme}`, async ({ page }, testInfo) => {
    let state = 'running', submissions = 0, cancellations = 0
    await prepare(page, theme, true)
    await page.route('**/api/generation/jobs**', route => {
      if (route.request().method() === 'POST') submissions++
      if (route.request().method() === 'DELETE') { cancellations++; state = 'cancelled' }
      return route.fulfill({ json: { ok: true, job: {
        id: 'atelier-fixture', status: state, provider: 'webui', seed: 42, progress: state === 'running' ? .45 : 1,
        error: state === 'failed' ? '隔离测试：生成暂时失败' : null,
        resultUrl: state === 'succeeded' ? '/atelier-fixture.jpg' : null, resultAvailable: state === 'succeeded', metadata: { seed: 42 },
      } } })
    })
    await page.route('**/atelier-fixture.jpg', route => route.fulfill({ path: 'assets/characters/natsume-home-cg.jpg', contentType: 'image/jpeg' }))
    await page.getByRole('button', { name: '专家模式', exact: true }).click()
    await page.locator('.engine-switch button').first().click()
    await page.getByTestId('sd-generate').click()
    await expect(page.locator('.stage-generating-title')).toBeVisible()
    await expect(page.locator('.gen-bar-size select')).toBeDisabled()
    await page.screenshot({ path: testInfo.outputPath(`workbench-${theme}-running.png`) })
    await page.getByRole('button', { name: '先停一下', exact: true }).click()
    await expect.poll(() => cancellations).toBe(1)
    await expect(page.locator('.stage-placeholder')).toHaveClass(/is-paused/)
    state = 'failed'
    await page.getByTestId('sd-generate').click()
    await expect(page.locator('.stage-error-detail')).toContainText('隔离测试')
    state = 'succeeded'
    await page.getByRole('button', { name: '重新生成', exact: true }).click()
    await expect(page.locator('.result-image')).toBeVisible()
    await expect(page.locator('.result-image')).toHaveJSProperty('complete', true)
    await expect(page.locator('.result-image')).not.toHaveJSProperty('naturalWidth', 0)
    await expect(page.locator('.result-image')).toHaveCSS('opacity', '1')
    await expect(page.locator('.stage-placeholder')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '存入作品册', exact: true })).toBeInViewport()
    expect((await page.locator('.result-image-actions').boundingBox())!.height).toBeLessThanOrEqual(80)
    await page.locator('.result-tools-disclosure summary').click()
    await expect(page.getByRole('button', { name: '加入分镜', exact: true })).toBeVisible()
    await page.locator('.result-tools-disclosure summary').click()
    await page.getByRole('button', { name: '存入作品册', exact: true }).click()
    await expect(page.getByRole('link', { name: '查看作品册', exact: true })).toBeVisible()
    while (await page.locator('.toast-close').count()) await page.locator('.toast-close').first().click()
    await page.screenshot({ path: testInfo.outputPath(`workbench-${theme}-result.png`) })
    expect(submissions).toBe(3)
  })

  test(`atelier responsive controls ${theme}`, async ({ page }, testInfo) => {
    await prepare(page, theme)
    for (const width of [1280, 1024, 820, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.locator('.gen-bar').scrollIntoViewIfNeeded()
      await expect(page.locator('.gen-bar-size select')).toBeInViewport()
      await page.screenshot({ path: testInfo.outputPath(`workbench-${theme}-${width}.png`) })
      await page.getByRole('button', { name: '专家模式', exact: true }).click()
      if (width >= 1024) {
        await page.setViewportSize({ width, height: 720 })
        await page.locator('.stage-quick-actions .btn').last().scrollIntoViewIfNeeded()
        await expect(page.locator('.stage-quick-actions .btn').last()).toBeInViewport()
        await page.screenshot({ path: testInfo.outputPath(`workbench-${theme}-${width}-short.png`) })
      }
      await page.getByRole('tab', { name: '任务', exact: true }).click()
      await expect(page.locator('.inspector-delivery')).toBeVisible()
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.getByRole('button', { name: '场景模式', exact: true }).click()
    }
  })
}

import { expect, test, type Page } from '@playwright/test'
import { textContrast } from './helpers/contrast'

// Existing-workflow checks start after the separately covered first-visit tour.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('aics_guest_guide_dismissed', '1'))
})

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
    // Algebraic contrast checks require an opaque surface; glass is reviewed visually.
    localStorage.setItem('atelier-desktop-appearance-v1', JSON.stringify({ theme, reducedGlass:true }))
  }, theme)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/prompt-builder?scene=sc001')
  await expect(page.locator('.material-drawer')).toBeVisible()
  await expect(page.locator('.director-inspector')).toBeVisible()
  await expect(page.locator('.stage-placeholder')).toBeVisible()
}

for (const theme of ['light', 'dark']) {
  test(`floating drawing feedback keeps generation reachable ${theme}`, async ({ page }, info) => {
    await prepare(page,theme,true)
    await page.setViewportSize({width:1440,height:960})
    await page.getByRole('button',{name:'专家模式',exact:true}).click()
    await page.locator('.engine-switch button').first().click()
    let fail = false, submissions = 0
    await page.route('**/api/interrogate', route => fail
      ? route.fulfill({status:500,json:{error:'隔离反推错误'}})
      : route.fulfill({json:{ok:true,engine:'pixai',model:'pixai-tagger-v1.0',mode:'tag',threshold:.17,
        tags:['sitting','park','blue_hair'],scores:{sitting:.9,park:.9,blue_hair:.9},caption:'',characterTags:[],
        rating:{general:1,sensitive:0,questionable:0,explicit:0}}}))
    await page.route('**/api/generation/jobs**', route => {
      if(route.request().method()==='POST')submissions++
      return route.fulfill({json:{ok:true,job:{id:'feedback-fixture',status:'running',provider:'webui',seed:42,progress:.2,resultAvailable:false,metadata:{seed:42}}}})
    })
    const upload=page.locator('input[type=file][accept="image/*"]').first()
    for(const viewport of [{width:1440,height:960},{width:1024,height:640}]) {
      await page.setViewportSize(viewport)
      await upload.setInputFiles('assets/characters/natsume-home-cg.jpg')
      const notice=page.locator('.toast-item').filter({hasText:'已采用 2 个参考词条'}).last()
      await expect(notice).toContainText('已排除参考人物特征 1 项')
      await notice.hover()
      const generate=page.getByRole('button',{name:'生成图片',exact:true})
      await expect(generate).toBeInViewport({ratio:1})
      const [toastBox,buttonBox,stackBox]=await Promise.all([notice.boundingBox(),generate.boundingBox(),page.locator('.toast-stack').boundingBox()])
      expect(stackBox!.x).toBeLessThanOrEqual(24)
      expect(stackBox!.y+stackBox!.height).toBeGreaterThan(viewport.height-40)
      expect(toastBox!.x+toastBox!.width).toBeLessThanOrEqual(buttonBox!.x)
      expect(await notice.locator('.toast-msg').evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
      await generate.click({trial:true})
      await page.screenshot({path:info.outputPath(`floating-feedback-${theme}-${viewport.width}.png`)})
    }
    fail=true
    await upload.setInputFiles('assets/characters/natsume-home-cg.jpg')
    const error=page.locator('.toast-item').filter({hasText:'隔离反推错误'})
    await expect(error).toBeVisible()
    await error.scrollIntoViewIfNeeded()
    const generate=page.getByRole('button',{name:'生成图片',exact:true})
    const [toastBox,buttonBox]=await Promise.all([error.boundingBox(),generate.boundingBox()])
    expect(toastBox!.x+toastBox!.width).toBeLessThanOrEqual(buttonBox!.x)
    await generate.click()
    await expect.poll(()=>submissions).toBe(1)
  })
  test(`atelier panels preserve drafts and focus mode ${theme}`, async ({ page }, testInfo) => {
    await prepare(page, theme)
    await expect(page.locator('.gen-bar-actions .btn-primary')).toBeDisabled()
    await expect(page.getByRole('button', { name: '绘制这一幕', exact: true })).toHaveCount(0)
    await expect(page.locator('.gen-bar-blocked')).not.toBeEmpty()
    const canvas = (await page.locator('.col-center').boundingBox())!
    const rail = (await page.locator('.director-inspector').boundingBox())!
    expect(rail.x).toBeGreaterThanOrEqual(canvas.x + canvas.width)
    await expect(page.getByRole('button', { name: '生成图片', exact: true })).toBeInViewport({ ratio: 1 })
    for (const selector of ['.scene-reference figcaption > strong', '.scene-reference-label', '.gen-bar-blocked']) {
      expect(await page.locator(selector).evaluate(textContrast), selector).toBeGreaterThanOrEqual(4.5)
    }
    await page.screenshot({ path: testInfo.outputPath(`workbench-${theme}-basic.png`) })
    await page.locator('[aria-controls="material-story"]').click()
    await page.locator('.story-input').fill('安静的午后，窗边的咖啡与一本打开的书。')
    await page.locator('[aria-controls="material-character"]').click()
    await page.locator('[aria-controls="material-story"]').click()
    await expect(page.locator('.story-input')).toHaveValue('安静的午后，窗边的咖啡与一本打开的书。')
    await expect(page.locator('#drawing-materials')).toBeVisible()
    await expect(page.locator('.director-inspector')).toBeVisible()
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

  test(`atelier responsive controls ${theme}`, async ({ page }, testInfo) => {
    await prepare(page, theme)
    for (const width of [1280, 1024]) {
      await page.setViewportSize({ width, height: 900 })
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.locator('.gen-bar').scrollIntoViewIfNeeded()
      await expect(page.locator('.gen-bar-size .studio-select-trigger')).toBeInViewport()
      await page.screenshot({ path: testInfo.outputPath(`workbench-${theme}-${width}.png`) })
      await page.getByRole('button', { name: '专家模式', exact: true }).click()
      await page.setViewportSize({ width, height: 720 })
      await page.locator('.stage-quick-actions .btn').last().scrollIntoViewIfNeeded()
      await expect(page.locator('.stage-quick-actions .btn').last()).toBeInViewport()
      await page.locator('.stage-quick-actions .btn').last().click()
      await expect(page.locator('[aria-controls="material-scenes"]')).toBeFocused()
      await expect(page.locator('#drawing-materials')).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath(`workbench-${theme}-${width}-short.png`) })
      await page.getByRole('tab', { name: '任务', exact: true }).click()
      await expect(page.locator('.inspector-delivery')).toBeVisible()
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.getByRole('button', { name: '场景模式', exact: true }).click()
    }
    if (theme === 'dark') {
      await page.setViewportSize({ width:900, height:720 })
      await expect(page.locator('#drawing-canvas .gen-bar')).toBeVisible()
      await expect(page.locator('#drawing-inspector .gen-bar')).toHaveCount(0)
    }
  })
}

test(`atelier mocked generation states and saving dark`, async ({ page }, testInfo) => {
  const theme = 'dark'
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
  await expect(page.locator('.engine-switch button').first()).toBeVisible()
  await page.locator('.engine-switch button').first().click()
  await page.getByTestId('sd-generate').click()
  await expect(page.locator('.stage-generating-title')).toBeVisible()
  await expect(page.locator('.gen-bar-size .studio-select-trigger')).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath(`workbench-${theme}-running.png`) })
  await page.getByRole('button', { name: '停止绘制', exact: true }).click()
  await expect.poll(() => cancellations).toBe(1)
  await expect(page.locator('.stage-placeholder')).toHaveClass(/is-paused/)
  state = 'failed'
  await page.getByTestId('sd-generate').click()
  await expect(page.locator('.stage-error-detail')).toContainText('隔离测试')
  await page.getByRole('button', { name: '查看恢复选项', exact: true }).click()
  await expect(page.locator('#inspector-tab-delivery')).toBeFocused()
  await expect(page.locator('.director-inspector')).toBeVisible()
  state = 'succeeded'
  await page.getByRole('button', { name: '重试生成', exact: true }).click()
  await expect(page.locator('.result-image')).toBeVisible()
  await expect(page.locator('.result-image')).toHaveJSProperty('complete', true)
  await expect(page.locator('.result-image')).not.toHaveJSProperty('naturalWidth', 0)
  await expect(page.locator('.result-image')).toHaveCSS('opacity', '1')
  await expect(page.locator('.stage-placeholder')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '存入作品册', exact: true })).toBeInViewport()
  const actionsBox = (await page.locator('.result-image-actions').boundingBox())!
  const imageBox = (await page.locator('.result-image-reveal').boundingBox())!
  const viewport = page.viewportSize()!
  expect(actionsBox.x).toBeGreaterThanOrEqual(0)
  expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(viewport.height + 1)
  const overlap = Math.min(actionsBox.x + actionsBox.width, imageBox.x + imageBox.width) - Math.max(actionsBox.x, imageBox.x) > 1
    && Math.min(actionsBox.y + actionsBox.height, imageBox.y + imageBox.height) - Math.max(actionsBox.y, imageBox.y) > 1
  expect(overlap, 'result controls must not cover the artwork').toBe(false)
  await page.locator('.image-continuation > summary').click()
  await expect(page.getByRole('button', { name: '加入分镜', exact: true })).toBeVisible()
  await page.getByRole('tab', { name:'生成', exact:true }).click()
  await page.getByRole('button', { name: '存入作品册', exact: true }).click()
  await expect(page.getByRole('link', { name: '查看作品册', exact: true })).toBeVisible()
  const notices = page.locator('.toast-close')
  for (let count = await notices.count(); count > 0; count = await notices.count()) {
    await notices.first().click()
    await expect(notices).toHaveCount(count - 1)
  }
  await page.screenshot({ path: testInfo.outputPath(`workbench-${theme}-result.png`) })
  expect(submissions).toBe(3)
})

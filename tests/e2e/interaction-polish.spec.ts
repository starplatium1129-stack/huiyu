import { expect, test, type Page } from '@playwright/test'
import MOCK_PORTS from '../../scripts/lib/e2e-ports.js'
import { readFileSync } from 'node:fs'

for (const theme of ['dark', 'light']) {
  test(`gallery original export preserves JPEG ${theme}`, async ({ page }) => {
    await page.addInitScript(value => {
      localStorage.setItem('aics_theme', value)
      const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8
      canvas.getContext('2d')!.fillRect(0, 0, 8, 8)
      localStorage.setItem('aics_pb_history', JSON.stringify([{ id: 'jpeg-export', sceneTitle: '导出验证', prompt: 'Original JPEG', image_data: canvas.toDataURL('image/jpeg') }]))
    }, theme)
    await page.goto('/gallery')
    await page.locator('.artwork').first().click()
    const downloading = page.waitForEvent('download')
    await page.getByRole('button', { name: '下载原图', exact: true }).click()
    const download = await downloading
    expect(download.suggestedFilename()).toMatch(/\.jpg$/)
    const bytes = readFileSync((await download.path())!)
    expect([...bytes.subarray(0, 3)]).toEqual([255, 216, 255])
  })

  test(`video submission error survives status refresh ${theme}`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.route('**/api/video/status', route => route.fulfill({ json: {
      ok: true, online: true, pending: 0, maxPending: 2,
      models: [{ id: 'minimax-h3', label: 'MiniMax H3', available: true, executable: true, modes: ['text', 'image', 'first-last-frame'], requirements: [], missing: [] }],
      qualities: [], defaults: { modelId: 'minimax-h3' }, t8: { available: true, reason: '测试环境' },
    } }))
    await page.route('**/api/video/jobs', route => route.fulfill({ status: 503, json: { ok: false, error: '测试视频提交失败，请重试' } }))
    await page.goto('/video-studio')
    await page.locator('.video-prompt').fill('A calm afternoon by the window')
    const submit = page.locator('.video-submit-panel button')
    await expect(submit).toBeEnabled()
    await submit.click()
    await expect(page.locator('.video-inline-message.error')).toContainText('ComfyUI 未连接')
    await expect(submit).toBeEnabled()
    await page.screenshot({ path: `.review-shots/video-submit-recovery-${theme}.png`, fullPage: true })
  })
}

test('large gallery keeps its initial render bounded and searches the complete archive', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('aics_pb_history', JSON.stringify(Array.from({ length: 3000 }, (_, index) => ({
      id: 'scale-' + index, sceneTitle: '规模条目 ' + index, prompt: 'archive performance fixture', timestamp: index + 1000,
    }))))
  })
  await page.goto('/gallery')
  await expect(page.locator('.gallery-count')).toContainText('3000')
  await expect(page.locator('.artwork')).toHaveCount(60)
  await page.getByRole('searchbox', { name: '搜索作品' }).fill('规模条目 2999')
  await expect(page.locator('.artwork')).toHaveCount(1)
  await expect(page.locator('.artwork')).toContainText('规模条目 2999')
})

test('video task query retries from the workspace without navigating away', async ({ page }) => {
  let recovered = false, requests = 0
  await page.route('**/api/video/jobs/retry-query', route => {
    requests += 1
    return recovered
      ? route.fulfill({ json: { ok: true, job: { id: 'retry-query', modelId: 'minimax-h3', prompt: 'A quiet afternoon', createdAt: 1, status: 'cancelled', progress: 0, resultAvailable: false, resultUrl: null, error: null } } })
      : route.fulfill({ status: 503, json: { ok: false, error: '任务查询暂时失败' } })
  })
  await page.goto('/video-studio?job=retry-query')
  await expect(page.locator('.video-inline-message.error')).toContainText('任务查询暂时失败')
  const before = requests
  recovered = true
  await page.getByRole('button', { name: '重新检测', exact: true }).click()
  await expect(page.locator('.video-job-state')).toHaveAttribute('data-state', 'cancelled')
  expect(requests).toBe(before + 1)
  await expect(page).toHaveURL(/job=retry-query/)
})

async function mockDrawingStatus(page: Page) {
  for (const path of ['/api/anima/status', '/api/creative/status']) {
    const response = await page.request.get(`http://127.0.0.1:${MOCK_PORTS.gateway}${path}`)
    expect(response.ok()).toBe(true)
    const body = await response.body()
    await page.route(`**${path}`, route => route.fulfill({ status: 200, contentType: 'application/json', body }))
  }
}

test('cached video workspace follows a different task-center link', async ({ page }) => {
  await page.route(/\/api\/video\/jobs\/cached-(one|two)$/, route => {
    const id = new URL(route.request().url()).pathname.split('/').pop()!
    return route.fulfill({ json: { ok: true, job: { id, modelId: 'minimax-h3', prompt: 'A quiet afternoon', createdAt: 1, status: id.endsWith('one') ? 'cancelled' : 'failed', progress: 0, resultAvailable: false, resultUrl: null, error: null } } })
  })
  await page.goto('/gallery')
  await expect(page.getByRole('heading', { name: '我的作品', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('aics_kv_store', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite')
      tx.objectStore('kv').put({ key: 'aics_task_center_v1', value: ['one', 'two'].map(id => ({ id, kind: 'video', title: '任务 ' + id, status: 'cancelled', route: '/video-studio?job=cached-' + id, backend: { kind: 'video', id: 'cached-' + id }, createdAt: 1, updatedAt: 1 })) })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  })
  await page.reload()
  const center = page.getByRole('dialog', { name: /任务中心/ })
  for (const [id, status] of [['one', 'cancelled'], ['two', 'failed']]) {
    await page.locator('.task-center-button:visible').click()
    await center.locator('.task-card').filter({ hasText: '任务 ' + id }).getByRole('link', { name: '返回工作台' }).click()
    await expect(page.locator('.video-job-state')).toHaveAttribute('data-state', status)
  }
})

for (const theme of ['dark', 'light']) {
  test(`saved video tasks reconnect and cancel without resubmission ${theme}`, async ({ page }) => {
    let status = 'running', reads = 0, cancels = 0, submissions = 0
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.route('**/api/video/jobs/recovery-one', async route => {
      if (route.request().method() === 'DELETE') { cancels += 1; status = 'cancelled' }
      else reads += 1
      await route.fulfill({ json: { ok: true, job: { id: 'recovery-one', modelId: 'minimax-h3', prompt: 'A quiet afternoon', createdAt: 1, status, progress: .4, resultAvailable: false, resultUrl: null, error: null } } })
    })
    await page.route('**/api/video/jobs', async route => { submissions += 1; await route.abort() })
    await page.goto('/gallery')
    await expect(page.getByRole('heading', { name: '我的作品', exact: true })).toBeVisible()
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('aics_kv_store', 1)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite')
        tx.objectStore('kv').put({ key: 'aics_task_center_v1', value: [{ id: 'saved-video', kind: 'video', title: '待恢复视频', status: 'running', route: '/video-studio?job=recovery-one', backend: { kind: 'video', id: 'recovery-one' }, createdAt: 1, updatedAt: 1 }] })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      db.close()
    })
    await page.reload()
    await page.locator('.task-center-button:visible').click()
    const center = page.getByRole('dialog', { name: /任务中心/ })
    await expect(center.locator('.task-card[data-state="running"]')).toHaveCount(1)
    await expect(center.getByRole('link', { name: '返回工作台' })).toHaveAttribute('href', '/video-studio?job=recovery-one')
    await center.screenshot({ path: `.review-shots/task-recovery-${theme}.png` })
    await center.getByRole('button', { name: '停止', exact: true }).click()
    await expect(center.locator('.task-card[data-state="cancelled"]')).toHaveCount(1)
    expect(cancels).toBe(1)
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(submissions).toBe(0)
  })
}

test('interface sound is opt-in and persists the explicit choice', async ({ page }) => {
  await page.goto('/')

  const sound = page.getByRole('button', { name: '开启界面音效' })
  await expect(sound).toHaveAttribute('aria-pressed', 'false')
  expect(await page.evaluate(() => localStorage.getItem('aics_interface_sound_v1'))).toBeNull()

  await sound.click()
  await expect(page.getByRole('button', { name: '关闭界面音效' })).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => localStorage.getItem('aics_interface_sound_v1'))).toBe('1')

  await page.reload()
  await expect(page.getByRole('button', { name: '关闭界面音效' })).toHaveAttribute('aria-pressed', 'true')
})

test('navigation uses hand-drawn icons and a settled selection indicator', async ({ page }) => {
  await page.goto('/')
  const nav = page.getByRole('navigation', { name: '主导航' })
  const sceneLink = nav.getByRole('link', { name: '灵感', exact: true })
  await expect(sceneLink.locator('svg.archive-icon')).toHaveCount(1)
  await sceneLink.click()
  await expect(page).toHaveURL(/scene-explorer$/)
  await expect(sceneLink).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.nav-links > .animated-selection')).toBeVisible()
  await expect(page.locator('.route-loader')).not.toHaveClass(/active/)
})

test('entering a character room keeps the interface clear of transition overlays', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('navigation').getByRole('link', { name: '房间', exact: true }).click()
  await expect(page).toHaveURL(/chat$/)
  await expect(page.locator('main h1')).toBeVisible()
  await expect(page.locator('.route-cut,.interaction-impulse')).toHaveCount(0)
})

test('gallery empty content uses the shared archive state panel', async ({ page }) => {
  await page.goto('/gallery')

  const state = page.locator('.archive-state-panel[data-kind="empty"]')
  await expect(state).toBeVisible()
  await expect(state).toContainText('展墙还在等你的第一幅作品')
  await expect(state.getByRole('link', { name: '开始绘制' })).toBeVisible()
})

test('scene cards keep drawing actions subordinate until interaction', async ({ page }) => {
  await page.goto('/scene-explorer')

  await expect(page.locator('.scene-grid').getByRole('link', { name: '开始绘制' }).first()).toHaveClass(/scene-draw-action/)
})

test('global motion feedback is suppressed when reduced motion is requested', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')

  const state = await page.evaluate(() => ({
    loader: getComputedStyle(document.querySelector('.route-loader')!).display,
    overlays: document.querySelectorAll('.route-cut,.interaction-impulse').length,
  }))
  expect(state).toEqual({ loader: 'none', overlays: 0 })
})

test('repeated navigation keeps a visible route view mounted', async ({ page }) => {
  await page.goto('/')

  for (const destination of [
    { label: '灵感', url: /\/scene-explorer$/, heading: '灵感场景' },
    { label: '参考画册', url: /\/showcase$/, heading: '把心动，一页页收藏。' },
    { label: '我的作品', url: /\/gallery$/, heading: '我的作品' },
  ]) {
    if (destination.label === '我的作品') {
      await page.getByRole('button', { name: '更多', exact: true }).click()
      await page.getByRole('dialog', { name: '更多页面', exact: true }).getByRole('link', { name: destination.label, exact: true }).click()
    } else await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: destination.label, exact: true }).click()
    await expect(page).toHaveURL(destination.url)
    await expect(page.locator('#main')).toContainText(destination.heading)
    expect(await page.locator('#main .route-view').evaluateAll(views => views.some(view => {
      const style = getComputedStyle(view)
      return style.opacity !== '0' && view.getBoundingClientRect().height > 0
    }))).toBe(true)
  }
})

for (const theme of ['dark', 'light']) {
  test(`copy failure has recovery feedback ${theme}`, async ({ page }) => {
    await page.addInitScript(value => {
      localStorage.setItem('aics_theme', value)
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
      document.execCommand = () => false
    }, theme)
    await page.goto('/color-script')
    await page.locator('.mood-card').first().click()
    await page.getByRole('button', { name: /复制 Prompt/ }).click()
    await expect(page.locator('.toast-msg')).toContainText('复制未完成')
    await expect(page.locator('.toast-msg')).not.toContainText('已复制')
    await expect(page.getByRole('button', { name: /复制 Prompt/ })).toBeFocused()
    await page.screenshot({ path: `.review-shots/feature-copy-${theme}.png`, fullPage: true })
  })
  test(`failed page navigation can be recovered ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: theme === 'dark' ? 390 : 1440, height: 900 })
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.route(/\/_app\/ScenarioView-[^/]+\.js$/, route => route.abort())
    await page.goto('/style')
    await page.getByRole('link', { name: '剧本与分幕', exact: true }).click()
    const recovery = page.getByRole('alert', { name: '页面加载恢复' })
    await expect(recovery).toBeVisible()
    await expect(page.getByRole('heading', { name: '画风', exact: true })).toBeVisible()
    await expect(recovery.getByRole('link', { name: '重新打开目标页面' })).toHaveAttribute('href', '/scenario')
    await page.screenshot({ path: `.review-shots/feature-recovery-${theme}.png`, fullPage: true })
    await page.unroute(/\/_app\/ScenarioView-[^/]+\.js$/)
    await recovery.getByRole('link', { name: '重新打开目标页面' }).click()
    await expect(page.getByRole('heading', { name: '剧本模式', exact: true })).toBeVisible()
    await expect(recovery).not.toBeVisible()
  })
}

test('gallery filtering does not retain hidden selections', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('aics_pb_history', JSON.stringify([
      { id: 'audit-one', sceneTitle: '审计甲', prompt: 'audit first', favorite: true },
      { id: 'audit-two', sceneTitle: '审计乙', prompt: 'audit second', favorite: false },
    ]))
  })
  await page.goto('/gallery')
  await page.getByRole('button', { name: '选择', exact: true }).click()
  await page.getByRole('button', { name: /全选/ }).click()
  await expect(page.locator('.gallery-bulk-count')).toContainText('已选 2 / 2')
  await page.getByLabel('搜索作品', { exact: true }).fill('审计甲')
  await expect(page.locator('.gallery-bulk-count')).toContainText('已选 0 / 1')
  await expect(page.getByRole('button', { name: '移入回收站（0）', exact: true })).toBeDisabled()
})

test('gallery viewer never retargets actions when its artwork leaves the active filter', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('aics_pb_history', JSON.stringify([
      { id: 'target-a', timestamp: 200, sceneTitle: '稳定对象甲', prompt: 'prompt A', favorite: true },
      { id: 'target-b', timestamp: 100, sceneTitle: '稳定对象乙', prompt: 'prompt B', favorite: true },
    ]))
  })
  await page.goto('/gallery')
  await page.getByRole('button', { name: /收藏 2/ }).click()
  await page.getByRole('button', { name: '欣赏作品：稳定对象甲', exact: true }).click()
  const viewer = page.getByRole('dialog', { name: '作品观赏模式' })
  await expect(viewer.getByRole('heading', { name: '稳定对象甲', exact: true })).toBeVisible()
  await viewer.getByRole('button', { name: '取消收藏', exact: true }).click()
  await expect(viewer).toBeHidden()
  await expect(page.getByRole('button', { name: '欣赏作品：稳定对象乙', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '欣赏作品：稳定对象甲', exact: true })).toHaveCount(0)
})


test('gallery keeps failed bulk items selected for retry', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('aics_pb_history', JSON.stringify([
      { id: 'audit-one', sceneTitle: '审计甲', prompt: 'audit first' },
      { id: 'audit-two', sceneTitle: '审计乙', prompt: 'audit second' },
    ]))
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, key) {
      if (value?.key === 'aics_pb_history' && Array.isArray(value.value) && value.value.length === 0) throw new DOMException('Test quota failure', 'QuotaExceededError')
      return key === undefined ? put.call(this, value) : put.call(this, value, key)
    }
  })
  await page.goto('/gallery')
  await page.getByRole('button', { name: '选择', exact: true }).click()
  await page.getByRole('button', { name: /全选/ }).click()
  await page.getByRole('button', { name: '移入回收站（2）', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '移入回收站', exact: true }).click()
  await expect(page.locator('.toast-msg')).toContainText('1 幅没成功')
  await expect(page.locator('.gallery-bulk-count')).toContainText('已选 1 / 1')
  await expect(page.getByRole('button', { name: '移入回收站（1）', exact: true })).toBeEnabled()
})

test('director blueprint round-trips full decisions and material conflicts', async ({ page }) => {
  await page.goto('/prompt-builder')
  await page.waitForTimeout(1800)
  await page.getByRole('button', { name: '专家模式', exact: true }).click()
  await page.locator('.engine-switch button').first().click()
  await expect(page.locator('.engine-switch button').first()).toHaveClass(/active/)

  await page.locator('[aria-controls="material-story"]').click()
  await page.locator('.story-input').fill('蓝图往返故事')
  await page.locator('#visualDescription').fill('A red umbrella beside a rain-covered window.')

  await page.getByRole('tab', { name: '画面', exact: true }).click()
  await page.locator('#stepMood > summary').click()
  await page.locator('.mood-card').filter({ hasText: '忧伤' }).click()

  await page.getByRole('tab', { name: '提示词', exact: true }).click()
  const tagInput = page.locator('#stepTags > input.tag-input[type="text"]')
  await tagInput.fill('school_uniform, pleated_skirt')
  await tagInput.press('Enter')
  await expect(page.locator('.manual-tag-en')).toContainText(['school_uniform', 'pleated_skirt'])

  await page.locator('.utility-trigger').click()
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出当前蓝图 JSON', exact: true }).click()
  const download = await downloading
  const payload = JSON.parse(readFileSync((await download.path())!, 'utf8'))
  expect(payload).toMatchObject({
    schema: 'aics-director-blueprint-v1', story: '蓝图往返故事',
    visualDescription: 'A red umbrella beside a rain-covered window.',
    colorMood: 'sad', directorMode: 'pro', subject: 'studio',
    selections: { composition: null }, drawEngine: 'sd',
  })
  expect(payload.manualTags).toEqual(['school_uniform', 'pleated_skirt'])
  expect(payload.anima).toEqual(expect.objectContaining({ modelId: expect.any(String) }))

  await tagInput.fill('bikini')
  await tagInput.press('Enter')
  await expect(page.locator('.manual-tag-en')).toContainText('bikini')
  await expect(page.locator('.manual-tag-en').filter({ hasText: 'school_uniform' })).toHaveCount(0)
  await page.locator('[aria-controls="material-story"]').click()
  await page.locator('#visualDescription').fill('Changed after export.')
  await page.getByRole('tab', { name: '画面', exact: true }).click()
  await page.locator('.mood-card').filter({ hasText: '快乐' }).click()

  await page.locator('.pb-blueprint-file-input').setInputFiles({
    name: 'director-blueprint.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)),
  })
  await expect(page.getByText('蓝图配置已完整载入', { exact: true })).toBeVisible()
  await page.locator('[aria-controls="material-story"]').click()
  await expect(page.locator('#visualDescription')).toHaveValue('A red umbrella beside a rain-covered window.')
  await page.getByRole('tab', { name: '画面', exact: true }).click()
  await expect(page.locator('.mood-card').filter({ hasText: '忧伤' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('tab', { name: '提示词', exact: true }).click()
  await expect(page.locator('.manual-tag-en')).toContainText(['school_uniform', 'pleated_skirt'])
  await expect(page.locator('.manual-tag-en').filter({ hasText: 'bikini' })).toHaveCount(0)
})


for (const theme of ['dark', 'light']) {
  test(`control configuration shows pending state and allows retry ${theme}`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    let requests = 0
    await page.route('**/api/config', async route => {
      if (route.request().method() !== 'POST') return route.continue()
      requests++
      await pending
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '模拟保存失败' }) })
    })
    try {
      await page.goto('/control')
      const saveButtons = page.getByRole('button', { name: '保存全部并检测', exact: true })
      await expect(saveButtons.first()).toBeEnabled()
      const saveButtonCount = await saveButtons.count()
      await saveButtons.first().click()
      const buttons = page.getByRole('button', { name: '正在保存…', exact: true })
      await expect(buttons).toHaveCount(saveButtonCount)
      for (const button of await buttons.all()) await expect(button).toBeDisabled()
      await page.locator('#sd-host').press('Enter')
      expect(requests).toBe(1)
      await page.locator('.service-config-panel').screenshot({ path: `.review-shots/feature-control-${theme}.png` })
      release()
      await expect(page.getByRole('button', { name: '保存全部并检测', exact: true }).first()).toBeEnabled()
    } finally { release() }
  })
}


for (const theme of ['dark', 'light']) {
  test(`batch selection progress and stop stay consistent ${theme}`, async ({ page }) => {
    await mockDrawingStatus(page)
    await page.setViewportSize({ width: theme === 'dark' ? 1440 : 390, height: 960 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    let submitted = 0, finish = false
    await page.route('**/api/anima/jobs', async route => {
      if (route.request().method() !== 'POST') return route.continue()
      submitted++
      await route.fulfill({ json: { ok: true, job: { id: 'batch-audit-' + submitted, status: 'queued' } } })
    })
    await page.route(/\/api\/anima\/jobs\/batch-audit-\d+$/, route => route.fulfill({ json: { ok: true, job: { id: 'batch-audit-1', status: finish ? 'succeeded' : 'running', seed: 42, resultAvailable: finish, resultUrl: '/batch-audit-result.svg' } } }))
    await page.route('**/batch-audit-result.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="gray"/></svg>' }))
    await page.goto('/prompt-builder')
    await page.getByRole('button', { name: '专家模式', exact: true }).click()
    await page.getByRole('tab', { name: '任务', exact: true }).click()
    await page.getByRole('button', { name: '批量出图 · 场景 / 多角色', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '批量出图', exact: true })
    await expect(panel.getByRole('group', { name: '选择批量模式' }).getByRole('button', { name: '按场景蓝图' })).toHaveAttribute('aria-pressed', 'true')
    await expect(panel.getByRole('group', { name: '每项出几张' }).getByRole('button', { name: '1 张' })).toHaveAttribute('aria-pressed', 'true')
    const animaEngine = panel.getByRole('group', { name: '选择批量出图引擎' }).getByRole('button', { name: 'Anima', exact: true })
    await animaEngine.click()
    await expect(animaEngine).toHaveAttribute('aria-pressed', 'true')
    await expect(panel.locator('.batch-scene-card')).toHaveCount(30)
    await panel.getByRole('button', { name: '全选匹配项', exact: true }).click()
    await panel.getByRole('button', { name: '取消全选', exact: true }).click()
    await expect(panel.locator('.batch-hint')).toContainText('已选 0 个场景')
    const safe = panel.locator('.batch-scene-card').filter({ hasNot: page.locator('.batch-scene-adult') })
    await safe.nth(0).click(); await safe.nth(1).click()
    await panel.getByLabel('搜索批量场景').fill('没有任何匹配_audit')
    await expect(panel.locator('.batch-hint')).toContainText('已选 2 个场景')
    await panel.getByRole('button', { name: '开始批量出图', exact: true }).click()
    await expect(panel.locator('.batch-result-grid .batch-card')).toHaveCount(2)
    await expect(panel.locator('.batch-progress-head')).toContainText('正在逐张出图')
    await panel.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '查看批量进度', exact: true }).click()
    await expect(panel.locator('.batch-progress-head')).toContainText('正在逐张出图')
    await panel.getByRole('button', { name: '停止（当前张完成后停）', exact: true }).click()
    finish = true
    await expect(panel.locator('.batch-card[data-state="cancelled"]')).toHaveCount(1)
    await expect(panel.locator('.batch-count-label')).toContainText('1 未执行')
    await expect(panel.locator('.batch-card[data-state="succeeded"]')).toHaveCount(1)
    expect(submitted).toBe(1)
    await panel.screenshot({ path: `.review-shots/batch-${theme}.png` })
  })
}


for (const theme of ['dark', 'light']) {
  test(`candidate comparison persists a preferred choice ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: theme === 'dark' ? 1440 : 390, height: 960 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript(value => {
      localStorage.setItem('aics_theme', value)
      localStorage.setItem('aics_pb_history', JSON.stringify([
        { id: 'compare-one', sceneTitle: '候选甲', prompt: 'first', seed: 101, size: '832x1216', image_url: '/assets/characters/thumbs/popular-furina.webp' },
        { id: 'compare-two', sceneTitle: '候选乙', prompt: 'second', seed: 202, size: '832x1216', image_url: '/assets/characters/thumbs/popular-raiden_shogun.webp' },
      ]))
    }, theme)
    await page.goto('/gallery?compare=compare-one,compare-two')
    const compare = page.getByRole('dialog', { name: '对比挑选', exact: true })
    await expect(compare).toBeVisible()
    await expect(compare.locator('.candidate-card')).toHaveCount(2)
    const imageBox = (await compare.locator('.candidate-image').first().boundingBox())!
    const picture = (await compare.locator('.candidate-image img').first().boundingBox())!
    expect(picture.height).toBeLessThanOrEqual(imageBox.height + 1)
    await compare.locator('.candidate-card').first().getByRole('button', { name: '选为首选' }).click()
    await expect(compare.locator('.candidate-card').first()).toHaveAttribute('data-choice', 'preferred')
    await compare.locator('.candidate-card').nth(1).getByRole('button', { name: '暂不采用' }).click()
    await expect(compare.locator('.candidate-card').nth(1)).toHaveAttribute('data-choice', 'rejected')
    await compare.screenshot({ path: `.review-shots/candidate-compare-${theme}.png` })
    await compare.getByRole('button', { name: '关闭对比' }).click()
    await page.reload()
    await expect(compare.locator('.candidate-card').first()).toHaveAttribute('data-choice', 'preferred')
    await expect(compare.locator('.candidate-card').nth(1)).toHaveAttribute('data-choice', 'rejected')
    await compare.locator('.candidate-card').nth(1).getByRole('button', { name: '恢复候选' }).click()
    await expect(compare.locator('.candidate-card').nth(1)).toHaveAttribute('data-choice', 'candidate')
    await compare.getByRole('button', { name: '关闭对比' }).click()
    await page.getByRole('button', { name: '欣赏作品：候选甲', exact: true }).click()
    await expect(page.locator('.art-viewer')).toHaveCSS('position', 'fixed')
    await expect.poll(async () => Math.abs((await page.locator('.art-viewer').boundingBox())!.width - page.viewportSize()!.width)).toBeLessThanOrEqual(1)
    await page.locator('.art-viewer .viewer-close').click()
  })
}

test('global task center retains a batch while visiting the gallery and control panel', async ({ page }) => {
  await mockDrawingStatus(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  let submitted = 0, finish = false
  await page.route('**/api/anima/jobs', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    submitted++
    await route.fulfill({ json: { ok: true, job: { id: 'center-audit-' + submitted, status: 'queued' } } })
  })
  await page.route(/\/api\/anima\/jobs\/center-audit-\d+$/, route => route.fulfill({ json: { ok: true, job: { id: 'center-audit-1', status: finish ? 'succeeded' : 'running', seed: 42, resultAvailable: finish, resultUrl: '/center-result.svg' } } }))
  await page.route('**/center-result.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="gray"/></svg>' }))
  await page.goto('/prompt-builder')
  await page.getByRole('button', { name: '专家模式', exact: true }).click()
  await page.getByRole('tab', { name: '任务', exact: true }).click()
  await page.getByRole('button', { name: '批量出图 · 场景 / 多角色', exact: true }).click()
  const batch = page.getByRole('dialog', { name: '批量出图', exact: true })
  await batch.getByRole('group', { name: '选择批量出图引擎' }).getByRole('button', { name: 'Anima', exact: true }).click()
  await batch.locator('.batch-scene-card').filter({ hasNot: page.locator('.batch-scene-adult') }).first().click()
  await batch.getByRole('button', { name: '开始批量出图', exact: true }).click()
  await expect(batch.locator('.batch-progress-head')).toContainText('正在逐张出图')
  await batch.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('link', { name: '房间', exact: true })).toHaveAttribute('target', '_blank')
  await page.locator('.nav-more-trigger').click()
  await page.getByRole('link', { name: '我的作品', exact: true }).click()
  await expect(page.getByRole('heading', { name: '我的作品', exact: true })).toBeVisible()
  await page.locator('.task-center-button:visible').click()
  const center = page.getByRole('dialog', { name: /任务中心/ })
  await expect(center.locator('.task-card[data-state="running"]')).toHaveCount(1)
  await center.screenshot({ path: '.review-shots/task-center-running.png' })
  await center.getByRole('button', { name: '关闭任务中心' }).click()
  await page.locator('.nav-more-trigger').click()
  await page.getByRole('link', { name: '控制面板', exact: true }).click()
  await expect(page.locator('.control-page')).toBeVisible()
  await page.locator('.task-center-button:visible').click()
  await expect(center.locator('.task-card[data-state="running"]')).toHaveCount(1)
  finish = true
  await expect(center.locator('.task-card[data-state="succeeded"]')).toHaveCount(1)
  await center.getByRole('link', { name: '查看结果', exact: true }).click()
  await expect(page.getByRole('heading', { name: '我的作品', exact: true })).toBeVisible()
  await expect(page.locator('.artwork')).toHaveCount(1)
  expect(submitted).toBe(1)
})


for (const theme of ['dark', 'light']) {
  test(`character portraits and asset health stay readable ${theme}`, async ({ page }) => {
    // This is a UI test; physical reference files are checked separately on the asset host.
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
    await page.route('**/api/character-reference-profile/furina', route => route.fulfill({ json: { characterId: 'furina', displayName: '芙宁娜', outfits: [{ outfitId: 'fixture', outfitName: '测试服装', isDefault: true, isNsfw: false, prose: '',
        references: Array.from({ length: 7 }, (_, index) => ({ id: 'fixture-' + index, name: '测试机位 ' + index, shotType: '正面', fileName: index + '.png', lens: '50mm', targetUsage: [], url: '/character-references/furina/fixture/' + index + '.png' })),
      }],
    } }))
    await page.route('**/character-references/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: image }))
    await page.setViewportSize({ width: theme === 'dark' ? 1440 : 390, height: 960 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.goto('/character?character=furina')
    await page.locator('.character-production > summary').click()
    const assets = page.getByRole('region', { name: '角色素材状态' })
    await expect(assets).toContainText('7 / 7 可读取')
    const portrait = page.locator(theme === 'dark' ? '.directory-item[data-character="furina"] .character-portrait' : '.directory-pocket .character-portrait')
    await expect(portrait).toBeVisible()
    await expect(portrait).toHaveAttribute('data-state', 'image')
    await assets.screenshot({ path: `.review-shots/character-assets-${theme}.png` })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  })
}

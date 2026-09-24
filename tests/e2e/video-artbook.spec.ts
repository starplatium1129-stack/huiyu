import { expect, test, type Page } from '@playwright/test'
import type { VideoJob, VideoStatusResponse } from '../../src/api/videoApi'
import { textContrast } from './helpers/contrast'

// Presentation fixtures only: no video model is called and the result URL is not a rendered clip.
async function mockVideo(page: Page, options: { online?: boolean; job?: VideoJob; statusError?: boolean } = {}) {
  const writes: string[] = []
  const status: VideoStatusResponse = {
    ok:true, online:options.online ?? false, pending:0, maxPending:2,
    models:[{ id:'minimax-h3', label:'MiniMax H3', family:'H3', tier:'本地', summary:'模拟模型，用于界面验收',
      executable:true, available:true, reason:'模拟就绪', modes:['text','image','first-last-frame'], requirements:[], missing:[] }],
    qualities:[{ id:'standard', label:'标准', summary:'日常创作', sizes:{ landscape:'832 × 480', portrait:'480 × 832', square:'640 × 640' } }],
    defaults:{ modelId:'minimax-h3', aspectRatio:'landscape', duration:3, camera:'still', motion:'subtle', quality:'standard' },
    t8:{ available:false, reason:'模拟加速未就绪，仍可查看技术状态' },
  }
  await page.route('**/api/video/**', route => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() !== 'GET') writes.push(path)
    if (path === '/api/video/status') return options.statusError
      ? route.fulfill({ status:503, json:{ ok:false, error:'模拟视频环境连接失败' } })
      : route.fulfill({ json:status })
    if (path === '/api/video/images') return route.fulfill({ json:{ ok:true, name:'aics_video_input_artbook.png', bytes:4096 } })
    if (options.job && path === `/api/video/jobs/${options.job.id}`) return route.fulfill({ json:{ ok:true, job:options.job } })
    return route.fulfill({ status:404, json:{ ok:false, error:'Unexpected fixture request' } })
  })
  await page.route('**/mock-artbook-result.mp4', route => route.fulfill({ status:204 }))
  return writes
}

function fixtureJob(status: VideoJob['status']): VideoJob {
  return { id:`artbook-${status}`, status, provider:'comfy', progress:status === 'succeeded' ? 1 : 0.25,
    estimatedSeconds:80, elapsedSeconds:20, modelId:'minimax-h3', prompt:'模拟镜头：窗边的角色轻轻挥手',
    width:832, height:480, duration:3, fps:24, seed:7, createdAt:Date.UTC(2026, 8, 20),
    resultAvailable:status === 'succeeded', resultUrl:status === 'succeeded' ? '/mock-artbook-result.mp4' : null,
    error:status === 'failed' ? 'CUDA out of memory: simulated artbook failure' : null, code:null }
}

for (const theme of ['dark', 'light']) for (const width of [1440, 390]) {
  test(`video artbook modes and keyboard frame input (mock) ${theme} ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height:width === 390 ? 844 : 960 })
    await page.emulateMedia({ reducedMotion:'reduce' })
    await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
    const writes = await mockVideo(page)
    await page.goto('/video-studio')
    await expect(page.getByRole('heading', { name:'把脑海中的一幕，写成镜头' })).toBeVisible()
    const navigation = page.getByRole('navigation', { name:'视频工作区导航' })
    await expect(navigation.getByRole('link')).toHaveCount(3)
    await expect(page.getByRole('button', { name:'生成视频', exact:true })).toBeDisabled()
    await expect(page.getByText('ComfyUI 离线', { exact:true })).toBeVisible()
    await expect(page.getByRole('link', { name:'打开控制面板' })).toHaveAttribute('href', '/control')
    const prompt = page.getByRole('textbox', { name:'镜头描述', exact:true })
    await prompt.fill('窗边的角色轻轻挥手，镜头保持静止，窗帘缓缓摆动。')
    await page.getByRole('button', { name:/图片动起来/ }).click()
    await expect(navigation.getByRole('link', { name:'准备画面' })).toBeVisible()
    const upload = page.getByLabel('上传视频首帧', { exact:true })
    await upload.focus()
    await expect(upload).toBeFocused()
    await expect(page.locator('.video-upload-drop--single')).toHaveCSS('outline-style', 'solid')
    const chooser = page.waitForEvent('filechooser')
    await page.keyboard.press('Enter')
    await (await chooser).setFiles('assets/characters/natsume-home-cg-512.webp')
    await expect(page.locator('.video-first-frame')).toBeVisible()
    await expect(page.locator('.video-first-frame')).toHaveCSS('object-fit', 'contain')
    await expect(page.locator('.video-first-frame-panel')).toContainText('输入首帧')
    await page.getByRole('button', { name:/首尾帧过渡/ }).click()
    await expect(page.getByRole('heading', { name:'锁定开始与结束画面' })).toBeVisible()
    await expect(page.locator('.video-frame-slot').first()).toContainText('A · 故事开始 / 输入首帧')
    await page.getByLabel('上传视频尾帧', { exact:true }).setInputFiles('assets/characters/natsume-home-cg-512.webp')
    await expect(page.locator('.video-dual-frame-grid img')).toHaveCount(2)
    await expect(prompt).toHaveValue('窗边的角色轻轻挥手，镜头保持静止，窗帘缓缓摆动。')
    await expect(page.locator('.video-model-catalog')).not.toHaveAttribute('open', '')
    await page.locator('.video-model-catalog summary').focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('.video-model-catalog')).toHaveAttribute('open', '')
    await expect(page.locator('.video-model-row')).toBeVisible()
    await page.locator('.video-model-catalog summary').click()
    for (const label of await page.locator('.video-brief-note, .video-frame-slot .field-label, .video-duration-note, .video-install-note').all()) {
      if (await label.isVisible()) expect(await label.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    await page.screenshot({ path:info.outputPath(`video-artbook-mock-${theme}-${width}.png`), fullPage:true })
    expect(writes).toEqual(['/api/video/images', '/api/video/images'])
  })
}

for (const status of ['queued', 'running', 'cancelling', 'cancelled', 'failed', 'succeeded'] as const) {
  test(`video task presentation ${status} (mock, no rendered media)`, async ({ page }) => {
    const job = fixtureJob(status)
    const writes = await mockVideo(page, { online:true, job })
    await page.goto(`/video-studio?job=${job.id}`)
    const queue = page.locator('#video-queue')
    const labels = { queued:'排队中', running:'生成中', cancelling:'取消中', cancelled:'已取消', failed:'生成失败', succeeded:'已完成' }
    await expect(queue.locator('.video-job-state')).toHaveText(labels[status])
    if (status === 'queued' || status === 'running') await expect(queue.getByRole('button', { name:'取消任务', exact:true })).toBeVisible()
    if (status === 'cancelled') await expect(queue).toContainText('镜头描述和输入画面仍在')
    if (status === 'failed') {
      await expect(queue.getByRole('alert')).toBeVisible()
      await queue.locator('.video-error-detail summary').click()
      await expect(queue.locator('.video-error-detail code')).toContainText('simulated artbook failure')
    }
    if (status === 'succeeded') {
      await expect(queue.locator('video[aria-label="生成的视频成片"]')).toHaveAttribute('src', '/mock-artbook-result.mp4')
      await expect(page.locator('video')).toHaveCount(1)
      await expect(queue.getByRole('link', { name:'下载这段故事 · MP4' })).toHaveAttribute('download', '')
      // Playback is deliberately not asserted: this fixture proves controls, never model output.
    }
    expect(writes).toEqual([])
  })
}

test('video environment error remains actionable (mock)', async ({ page }) => {
  const writes = await mockVideo(page, { statusError:true })
  await page.goto('/video-studio')
  await expect(page.locator('.video-environment-panel [role="alert"]')).toContainText('模拟视频环境连接失败')
  await expect(page.getByRole('button', { name:'重新检测', exact:true })).toBeEnabled()
  await expect(page.getByRole('link', { name:'打开控制面板' })).toBeVisible()
  await expect(page.getByRole('button', { name:'生成视频', exact:true })).toBeDisabled()
  expect(writes).toEqual([])
})

import { test, expect, type Request } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const manifest = JSON.parse(readFileSync(resolve(__dirname, '../../dist/.vite/manifest.json'), 'utf8')) as Record<string, { file: string }>
function chunk(component: string) {
  const entry = manifest[`src/components/${component}.vue`]
  if (!entry) throw new Error(`Missing production chunk for ${component}`)
  return '/' + entry.file
}

for (const theme of ['dark', 'light']) for (const mode of ['basic', 'pro']) {
  test(`workbench loads panels on first use and retains drafts ${theme} ${mode}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript(({ theme, mode }) => {
      localStorage.setItem('aics_theme', theme)
      localStorage.setItem('aics_pb_director_mode', mode)
    }, { theme, mode })
    const scripts = new Set<string>()
    const pending = new Set<Request>()
    page.on('request', request => {
      if (!['script', 'stylesheet'].includes(request.resourceType())) return
      pending.add(request)
      if (request.resourceType() === 'script') scripts.add(new URL(request.url()).pathname)
    })
    page.on('requestfinished', request => pending.delete(request))
    page.on('requestfailed', request => pending.delete(request))
    await page.goto('/prompt-builder')
    await expect(page.locator('.gen-bar')).toBeVisible()
    await expect(page.locator('#material-character .char-source')).toBeVisible()
    await expect(page.locator('#stepResult')).toBeVisible()
    await expect.poll(() => pending.size).toBe(0)
    for (const component of ['director/PromptMaterialScenes', 'director/DirectorStoryPanel', 'HistoryPanel',
      'director/PromptInspectorStyle', 'ArtistStylePicker', 'director/DirectorTagWorkbench', 'director/PromptResultDialogs']) {
      expect(scripts.has(chunk(component)), `${component} must wait for its visible panel`).toBe(false)
    }
    if (mode === 'pro') {
      for (const component of ['director/PromptInspectorPrompt', 'director/PromptInspectorDelivery', 'VoiceStudio']) {
        expect(scripts.has(chunk(component)), `${component} must wait for its tab`).toBe(false)
      }
    }

    await page.locator('[aria-controls="material-scenes"]').click()
    const sceneSearch = page.locator('#material-scenes .scene-search')
    await expect(sceneSearch).toBeVisible()
    expect(scripts.has(chunk('director/PromptMaterialScenes'))).toBe(true)
    await sceneSearch.fill('樱花')
    await page.locator('[aria-controls="material-character"]').click()
    await page.locator('[aria-controls="material-scenes"]').click()
    await expect(sceneSearch).toHaveValue('樱花')
    if (mode === 'basic') await page.getByRole('button', { name: '专家模式', exact: true }).click()

    await page.getByRole('tab', { name: '画面', exact: true }).click()
    await page.getByTestId('artist-style-picker').locator('summary').click()
    const artistSearch = page.getByLabel('搜索画师或作品', { exact: true })
    await artistSearch.fill('米山舞')
    await expect(page.locator('.artist-style-grid button').first()).toBeVisible()
    expect(scripts.has(chunk('ArtistStylePicker'))).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`workbench-${theme}-${mode}-style.png`), fullPage: true })

    await page.getByRole('tab', { name: '提示词', exact: true }).click()
    const tagSearch = page.getByRole('searchbox', { name: '搜索词条', exact: true })
    await expect(tagSearch).toBeVisible()
    await tagSearch.fill('sky')
    expect(scripts.has(chunk('director/DirectorTagWorkbench'))).toBe(true)
    await page.getByRole('tab', { name: '生成', exact: true }).click()
    await page.getByRole('tab', { name: '提示词', exact: true }).click()
    await expect(tagSearch).toHaveValue('sky')
    await page.getByRole('tab', { name: '画面', exact: true }).click()
    await expect(artistSearch).toHaveValue('米山舞')

    await page.getByRole('tab', { name: '任务', exact: true }).click()
    await expect(page.getByRole('group', { name: '出图自动入册', exact: true })).toBeVisible()
    await expect.poll(() => scripts.has(chunk('VoiceStudio'))).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`workbench-${theme}-${mode}-delivery.png`), fullPage: true })
  })
}

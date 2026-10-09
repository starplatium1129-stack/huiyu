import { expect, test, type Page } from '@playwright/test'
import type { LocalSetupResponse } from '../../types/local-setup'
import type { ControlStatus } from '../../src/types/api'
import { textContrast } from './helpers/contrast'

const base = process.env.AICS_UI_AUDIT_URL || ''
async function mockControl(page: Page) {
  const state = { ok: true, running: true, sdOnline: true, comfyOnline: true, ttsOnline: false,
    ollamaOnline: true, ollamaModels: [], ollamaVram: 0, webuiManaged: true, comfyManaged: true,
    llama: { online: true, managed: true, host: 'http://127.0.0.1:8041', label: 'fixture chat' },
    modeBusy: false, operation: null, sdHost: 'http://127.0.0.1:7860', comfyHost: 'http://127.0.0.1:8188',
    ttsHost: 'http://127.0.0.1:9880', ollamaHost: '', localLink: 'http://127.0.0.1:3000/',
    shareLinkAvailable: false, tunnelStatus: 'disabled', tunnelAvailable: true, uptime: 60, voices: {},
    scripts: { webui: true, comfy: true, voiceStart: true, voiceStop: true } } satisfies ControlStatus
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  const setup: LocalSetupResponse = {
    ok: true, checkedAt: 1_791_083_000_000, recommendedModel: 'anima-miaomiao-v1.6',
    workspace: { path: 'D:\\AI', state: 'present' },
    comfy: { path: 'D:\\AI\\ComfyUI', installation: 'present', layout: 'venv', host: state.comfyHost, connection: 'online' },
    models: ['anima-miaomiao-v1.6', 'qwen-encoder', 'qwen-vae', 'L_NENE_V21_ANIMA', 'L_NAT_V21_ANIMA'].map((id, index) => ({
      id, label: id, path: `D:\\AI\\ComfyUI\\models\\${id}`, state: 'present', bytes: 10, required: index < 3,
      preparation: { url: 'https://huggingface.co/circlestone-labs/Anima/resolve/fixture/model.safetensors',
        modelCardUrl: 'https://huggingface.co/circlestone-labs/Anima', licenseUrl: 'https://huggingface.co/circlestone-labs/Anima/blob/fixture/LICENSE.md',
        upstreamLicenseUrl: null, revision: 'fixture', expectedBytes: 10, sha256: 'b'.repeat(64) },
    })),
    nodes: { state: 'checked', required: ['ImageSharpenKJ'], missing: [] },
    hardware: { state: 'unknown', devices: [], ramBytes: null },
  }
  await page.route('**/api/**', route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'POST') {
      posts.push({ path, body: request.postDataJSON() || {} })
      return route.fulfill({ json: { ok: true } })
    }
    if (path === '/api/status') return route.fulfill({ json: state })
    if (path === '/api/local-setup') return route.fulfill({ json: setup })
    if (path === '/api/logs') return route.fulfill({ json: { logs: ['[16:00:00] 服务已连接'], total: 1, operation: null } })
    return route.fulfill({ json: { ok: true } })
  })
  return { state, posts, setup }
}
for (const theme of ['dark', 'light']) {
  test(`drawing preparation stays reachable without models ${theme}`, async ({ page }) => {
    const { setup, posts } = await mockControl(page)
    setup.comfy.installation = 'missing'; setup.comfy.connection = 'offline'
    setup.nodes.state = 'unknown'; setup.nodes.required = []; setup.nodes.missing = []
    setup.models[0].state = 'missing'; setup.models[0].bytes = null
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 1366, height: 960 })
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.goto(base + '/control')
    const panel = page.locator('#control-setup')
    await expect(panel.getByRole('list', { name: '绘图准备进度' })).toBeVisible()
    const draft = panel.getByRole('link', { name: '先准备创作草稿', exact: true })
    await expect(draft).toBeVisible()
    await expect(panel.getByRole('button', { name: '一键准备所选能力', exact: true })).toBeDisabled()
    await expect(panel.locator('.setup-chat')).not.toHaveAttribute('open', '')
    await expect.poll(() => draft.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
    await draft.focus(); await expect(draft).toBeFocused()
    await page.screenshot({ path: `runtime/setup-optimization/control-preparation-${theme}.png`, fullPage: true })
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/prompt-builder$/)
    await expect(page.getByRole('heading', { name: '绘图画室', exact: true })).toBeVisible()
    expect(posts).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  })
  for (const width of [1366, 1920]) {
    test(`control layout ${theme} ${width}`, async ({ page }) => {
      const { posts } = await mockControl(page)
      await page.setViewportSize({ width, height: 1000 })
      await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
      await page.goto(base + '/control')
      await expect(page.locator('.control-count')).toHaveText('3 / 4 服务在线')
      await expect(page.locator('.status-tile')).toHaveCount(4)
      await expect(page.locator('.control-mobile-nav')).toBeHidden()
      await expect(page.locator('.control-rail')).toBeVisible()
      await expect(page.locator('.control-rail-link')).toHaveCount(7)
      await expect(page.locator('.control-rail-foot button').first()).toBeVisible()
      const controls = (await page.locator('.service-rows').boundingBox())!
      expect(controls.y + controls.height).toBeLessThan(1000)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      const sharing = page.locator('#control-share')
      await expect(sharing).not.toHaveAttribute('open', '')
      await page.locator('.control-rail a[href="#control-share"]').click()
      await expect(sharing).toHaveAttribute('open', '')
      await expect(sharing.locator('.security-note')).toBeVisible()
      await sharing.locator('summary').focus()
      await page.keyboard.press('Enter')
      await expect(sharing).not.toHaveAttribute('open', '')
      await page.locator('.control-rail a[href="#control-logs"]').click()
      await expect(page.locator('#control-logs')).toHaveAttribute('open', '')
      await expect(page.locator('.log-box')).toBeVisible()
      await expect(page.locator('.control-rail a[href="#control-logs"]')).toHaveAttribute('aria-current', 'location')
      expect(posts).toEqual([])
    })
  }
}
test('configuration survives a refresh and saves all edited fields once', async ({ page }) => {
  const { posts } = await mockControl(page)
  await page.goto(base + '/control')
  await expect(page.locator('.control-count')).toHaveText('3 / 4 服务在线')
  await page.locator('#tts-host').fill('http://127.0.0.1:9881')
  await page.locator('#comfy-host').fill('http://127.0.0.1:8189')
  await page.getByRole('button', { name: '检测所有服务', exact: true }).click()
  await expect(page.getByRole('button', { name: '检测所有服务', exact: true })).toBeEnabled()
  await expect(page.locator('#tts-host')).toHaveValue('http://127.0.0.1:9881')
  await expect(page.locator('#comfy-host')).toHaveValue('http://127.0.0.1:8189')
  await page.getByRole('button', { name: '保存全部并检测', exact: true }).click()
  await expect.poll(() => posts.length).toBe(1)
  expect(posts[0].body).toMatchObject({ ttsHost: 'http://127.0.0.1:9881', comfyHost: 'http://127.0.0.1:8189' })
})
test('stopping a service still requires confirmation', async ({ page }) => {
  const { posts } = await mockControl(page)
  await page.goto(base + '/control')
  await expect(page.locator('.control-count')).toHaveText('3 / 4 服务在线')
  await page.locator('.service-row').filter({ hasText: 'ComfyUI' }).getByRole('button', { name: '停止', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  expect(posts).toEqual([])
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  expect(posts).toEqual([])
})

test('failed polling shows recovery and prevents operations based on stale status', async ({ page }) => {
  await mockControl(page)
  await page.goto(base + '/control')
  await expect(page.locator('.control-count')).toHaveText('3 / 4 服务在线')
  await page.route('**/api/status*', route => route.fulfill({ status: 503, json: { error: 'offline' } }))
  await page.getByRole('button', { name: '检测所有服务', exact: true }).click()
  await expect(page.locator('.control-alert')).toBeVisible()
  await expect(page.locator('.control-count')).toHaveText('服务状态待确认')
  await expect(page.locator('.mode-card').first()).toBeDisabled()
  await expect(page.getByRole('button', { name: '重试检测', exact: true })).toBeEnabled()
})

import { expect, test, type Page } from '@playwright/test'

const base = process.env.AICS_UI_AUDIT_URL || ''
async function mockControl(page: Page) {
  const state = { ok: true, running: true, sdOnline: true, comfyOnline: true, ttsOnline: false,
    ollamaOnline: true, ollamaModels: [], ollamaVram: 0, webuiManaged: true, comfyManaged: true,
    modeBusy: false, operation: null, sdHost: 'http://127.0.0.1:7860', comfyHost: 'http://127.0.0.1:8188',
    ttsHost: 'http://127.0.0.1:9880', ollamaHost: '', localLink: 'http://127.0.0.1:3000/',
    shareLinkAvailable: false, tunnelStatus: 'disabled', tunnelAvailable: true, uptime: 60, voices: {},
    scripts: { webui: true, comfy: true, voiceStart: true, voiceStop: true } }
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  await page.route('**/api/**', route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'POST') {
      posts.push({ path, body: request.postDataJSON() || {} })
      return route.fulfill({ json: { ok: true } })
    }
    if (path === '/api/status') return route.fulfill({ json: state })
    if (path === '/api/logs') return route.fulfill({ json: { logs: ['[16:00:00] 服务已连接'], total: 1, operation: null } })
    return route.fulfill({ json: { ok: true } })
  })
  return { state, posts }
}
for (const theme of ['dark', 'light']) {
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
      await expect(page.locator('.control-rail-link')).toHaveCount(6)
      await expect(page.locator('.control-rail-foot button').first()).toBeVisible()
      const controls = (await page.locator('.service-rows').boundingBox())!
      expect(controls.y + controls.height).toBeLessThan(1000)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      await page.locator('a[href="#control-logs"]').click()
      await expect(page.locator('#control-logs')).toHaveAttribute('open', '')
      await expect(page.locator('.log-box')).toBeVisible()
      await expect(page.locator('a[href="#control-logs"]')).toHaveAttribute('aria-current', 'location')
      expect(posts).toEqual([])
    })
  }
}
test('configuration survives a refresh and saves all edited fields once', async ({ page }) => {
  const { posts } = await mockControl(page)
  await page.goto(base + '/control')
  await expect(page.locator('.control-count')).toHaveText('3 / 4 服务在线')
  await page.locator('#sd-host').fill('http://127.0.0.1:7861')
  await page.locator('#comfy-host').fill('http://127.0.0.1:8189')
  await page.getByRole('button', { name: '检测所有服务', exact: true }).click()
  await expect(page.getByRole('button', { name: '检测所有服务', exact: true })).toBeEnabled()
  await expect(page.locator('#sd-host')).toHaveValue('http://127.0.0.1:7861')
  await expect(page.locator('#comfy-host')).toHaveValue('http://127.0.0.1:8189')
  await page.getByRole('button', { name: '保存全部并检测', exact: true }).click()
  await expect.poll(() => posts.length).toBe(1)
  expect(posts[0].body).toMatchObject({ sdHost: 'http://127.0.0.1:7861', comfyHost: 'http://127.0.0.1:8189' })
})
test('stopping a service still requires confirmation', async ({ page }) => {
  const { posts } = await mockControl(page)
  await page.goto(base + '/control')
  await expect(page.locator('.control-count')).toHaveText('3 / 4 服务在线')
  await page.locator('.service-row').filter({ hasText: 'SD WebUI' }).getByRole('button', { name: '停止', exact: true }).click()
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

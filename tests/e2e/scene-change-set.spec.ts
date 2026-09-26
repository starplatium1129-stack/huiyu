import { installDesktopHostFixture } from './helpers/desktopHost'
import { expect, test, type Page } from '@playwright/test'
import type { SceneDraft, SceneMaintenanceSnapshot, SceneChangesPayload } from '../../src/types/api'
import { GUEST_GUIDE_DISMISSED_KEY, THEME_KEY } from '../../src/utils/storageKeys'

test.use({ serviceWorkers: 'block' })

const scene = (id: string, title = '场景记录 · ' + id): SceneDraft => ({ id, title, category: '日常', char: 'nene',
  story: '仅用于隔离界面验证的场景记录。', rating: 'All', lora: '', emotion: '', season: '', time: '', timeOfDay: '',
  location: '', weather: '', camera: '', lighting: '', tags: [], usage: [], storyJa: '', prompt: 'fixture', negative: '' })
const blueprint = (id: string) => ({ id, title: '蓝图记录 · ' + id, characterId: 'nene', category: '日常', description: '隔离验证',
  location: '', action: '', timeOfDay: '', lighting: '', camera: '', mood: '', recommendedSize: '832x1216', adult: false,
  promptProse: 'fixture', promptTokens: ['fixture'], negativeTokens: ['fixture'], sceneTags: [], sampleRating: 'All' as const })
const baseline = (): SceneMaintenanceSnapshot => ({ scenes: [scene('sc998'), scene('sc999'), scene('sc1000')],
  tags: [], curation: { reviewSceneIds: ['sc999'] }, blueprints: [blueprint('bp_001')] })
const edited = (): SceneMaintenanceSnapshot => ({ scenes: [scene('sc998', '修改后的场景'), scene('sc1000'), scene('sc1001', '新增场景')],
  blueprints: [blueprint('bp_002')], tags: [{ id: 't1', en: 'fixture', cn: '测试标签', cat: 'Scene', weight: 1 }], curation: {} })
const impact = { ok: true, baseVersion: 42, version: 42, added: ['sc1001'], updated: ['sc998'], removed: ['sc999'],
  blueprints: { added: ['bp_002'], updated: [], removed: ['bp_001'] },
  related: [{ kind: 'curation', id: 'sc999', reason: '策展引用：reviewSceneIds' }], checks: ['保存时校验场景与蓝图'], unknown: ['真实模型画面与设备尚未验收'] }
const goto = (page: Page) => page.goto(process.env.AICS_SCENE_UI_TEST_URL || (process.env.AICS_UI_AUDIT_URL || '') + '/scene-manager')

test.beforeEach(async ({ page, baseURL }) => {
  const origin = new URL(process.env.AICS_UI_AUDIT_URL || baseURL!).origin
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  // Every unhandled API call is rejected. No scene write can reach real source data.
  await page.route('**/api/**', route => route.fulfill({ status: 403,
    json: { ok: false, error: 'Unmocked API forbidden', code: 'SCENE_TEST_NETWORK_BLOCKED' } }))
  const snapshot = baseline()
  await page.route('**/data/**', route => {
    const file = new URL(route.request().url()).pathname.split('/').pop()!
    const metadata: Record<string, unknown> = { 'characters.json': [], 'popular-characters.json': { characters: [] },
      'scene-blueprints.json': { blueprints: snapshot.blueprints }, 'curation.json': snapshot.curation, 'scenes-index.json': {},
      'scenes-nene.json': snapshot.scenes, 'scenes-core.json': snapshot.scenes }
    return route.fulfill({ json: metadata[file] ?? [] })
  })
  await page.route('**/api/maintenance/scenes-state', route => route.fulfill({ json: { ok: true, version: 42, nextSceneId: 'sc1001',
    sceneCount: 3, retiredCount: 0, snapshot } }))
  await page.route('**/api/maintenance/home-hero', route => route.fulfill({ json: { ok: true, version: 1, entries: {} } }))
  await page.route('**/api/maintenance/scenes/preview', route => route.fulfill({ json: impact }))
  await page.addInitScript(key => {
    localStorage.setItem(key, '1')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } })
  }, GUEST_GUIDE_DISMISSED_KEY)
})

async function stageSnapshot(page: Page) {
  await page.getByRole('button', { name: '导入', exact: true }).click()
  await page.getByRole('textbox', { name: '场景导入 JSON' }).fill(JSON.stringify({ ...edited(), version: 1 }))
  await page.getByRole('button', { name: '载入完整快照草稿', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click()
  await expect(page.getByRole('button', { name: '全量导入到项目', exact: true })).toBeVisible()
}

async function editTitle(page: Page, title: string) {
  await page.getByRole('button', { name: /^场景库/ }).click()
  await page.getByRole('searchbox', { name: '搜索管理场景' }).fill('sc1000')
  const catalog = page.locator('.maintenance-catalog:visible')
  await catalog.getByRole('button', { name: '编辑', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('标题 *', { exact: true }).fill(title)
  return dialog
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [1440, 390]) {
    test(`impact preview ${theme} ${width}: text, keyboard, contrast and layout`, async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.setViewportSize({ width, height: width === 390 ? 844 : 960 })
      await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: THEME_KEY, value: theme })
      await goto(page)
      await stageSnapshot(page)
      await page.getByRole('button', { name: '影响预览', exact: true }).click()
      const panel = page.getByTestId('scene-impact')
      await expect(panel).toContainText('sc1001')
      await expect(panel).toContainText('sc999')
      await expect(panel).toContainText('bp_002')
      await expect(panel).toContainText('策展引用')
      await expect(panel).toContainText('真实模型画面与设备尚未验收')
      const refresh = panel.getByRole('button', { name: '刷新影响预览' })
      await refresh.focus()
      await expect(refresh).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(panel.getByTestId('scene-impact-result')).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      const contrast = await panel.evaluate(root => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
        const ctx = canvas.getContext('2d')!
        const rgba = (css: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data] }
        const luminance = (rgb: number[]) => rgb.slice(0, 3).reduce((sum, value, i) => {
          const n = value / 255; return sum + (n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i]
        }, 0)
        return [...root.querySelectorAll('p,summary,h2,h3,li,code,button')].filter(el => (el as HTMLElement).getClientRects().length && el.textContent?.trim()).map(el => {
          const layers: number[][] = []
          for (let item: Element | null = el; item; item = item.parentElement) layers.unshift(rgba(getComputedStyle(item).backgroundColor))
          let bg = [255, 255, 255]
          for (const layer of layers) bg = bg.map((v, i) => layer[i] * layer[3] / 255 + v * (1 - layer[3] / 255))
          const fg = rgba(getComputedStyle(el).color)
          const text = fg.slice(0, 3).map((v, i) => v * fg[3] / 255 + bg[i] * (1 - fg[3] / 255))
          const a = luminance(text), b = luminance(bg)
          return { text: el.textContent!.trim().slice(0, 45), ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) }
        })
      })
      expect(contrast.filter(item => item.ratio < 4.5)).toEqual([])
      await page.screenshot({ path: testInfo.outputPath(`scene-impact-${theme}-${width}.png`), fullPage: true })
      expect(errors).toEqual([])
    })
  }
}

test('ordinary save posts only the exact changes and the loaded version', async ({ page }) => {
  let body: SceneChangesPayload | undefined
  await page.route('**/api/maintenance/scenes/changes', route => {
    body = route.request().postDataJSON()
    return route.fulfill({ json: { ok: true, count: 3, version: 43, snapshot: edited(), backup: 'isolated-fixture' } })
  })
  await goto(page)
  await stageSnapshot(page)
  await page.getByRole('button', { name: '保存到项目', exact: true }).click()
  await expect(page.locator('#maintenanceTitle')).toHaveText('已同步')
  expect(body).toEqual({ baseVersion: 42, changeSet: { version: 1,
    scenes: { upsert: [edited().scenes[0], edited().scenes[2]], remove: ['sc999'] },
    blueprints: { upsert: edited().blueprints, remove: ['bp_001'] }, tags: edited().tags, curation: {} } })
})

test('preview posts the exact delta and never issues a save or import request', async ({ page }) => {
  let body: SceneChangesPayload | undefined
  const writes: string[] = []
  page.on('request', request => {
    if (request.method() !== 'GET' && /\/api\/maintenance\/scenes(?:\/(?:changes|import))?$/.test(new URL(request.url()).pathname)) writes.push(request.url())
  })
  await page.route('**/api/maintenance/scenes/preview', route => {
    body = route.request().postDataJSON()
    return route.fulfill({ json: impact })
  })
  await goto(page)
  await stageSnapshot(page)
  await page.getByRole('button', { name: '影响预览', exact: true }).click()
  await expect(page.getByTestId('scene-impact-result')).toBeVisible()
  expect(body).toEqual({ baseVersion: 42, changeSet: { version: 1,
    scenes: { upsert: [edited().scenes[0], edited().scenes[2]], remove: ['sc999'] },
    blueprints: { upsert: edited().blueprints, remove: ['bp_001'] }, tags: edited().tags, curation: {} } })
  expect(writes).toEqual([])
  await expect(page.locator('#maintenanceTitle')).toHaveText('有尚未保存的修改')
})

test('explicit full import uses its own endpoint after confirmation', async ({ page }) => {
  let body: unknown
  await page.route('**/api/maintenance/scenes/import', route => {
    body = route.request().postDataJSON()
    return route.fulfill({ json: { ok: true, count: 3, version: 43, snapshot: edited(), backup: 'isolated-fixture' } })
  })
  await goto(page)
  await stageSnapshot(page)
  await page.getByRole('button', { name: '全量导入到项目', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toContainText('退役 1 个场景')
  await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click()
  await expect(page.locator('#maintenanceTitle')).toHaveText('已同步')
  expect(body).toEqual({ ...edited(), baseVersion: 42 })
})

for (const endpoint of ['preview', 'import'] as const) {
  test(`${endpoint} conflicts preserve the full draft and display recovery guidance`, async ({ page }) => {
    await page.route('**/api/maintenance/scenes/' + endpoint, route => route.fulfill({ status: 409,
      json: { ok: false, error: '场景库已更新', conflict: { baseVersion: 42, currentVersion: 99, changedIds: ['sc1001'] } } }))
    await goto(page)
    await stageSnapshot(page)
    if (endpoint === 'preview') {
      await page.getByRole('button', { name: '影响预览', exact: true }).click()
      await expect(page.getByTestId('scene-impact').getByRole('alert')).toContainText('先导出本地草稿')
      await expect(page.getByTestId('scene-impact-result')).toHaveCount(0)
    } else {
      await page.getByRole('button', { name: '全量导入到项目', exact: true }).click()
      await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click()
      await expect(page.locator('#maintenanceHint')).toContainText('先导出本地草稿')
    }
    await expect(page.locator('#maintenanceTitle')).toHaveText('有尚未保存的修改')
    await expect(page.getByRole('button', { name: '保存到项目', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: /^场景库/ }).click()
    await page.getByRole('searchbox', { name: '搜索管理场景' }).fill('sc1001')
    await expect(page.getByRole('region', { name: '场景详情', exact: true })).toContainText('新增场景')
  })
}

test('editing invalidates the visible preview and a 409 preserves the draft', async ({ page }) => {
  await page.route('**/api/maintenance/scenes/changes', route => route.fulfill({ status: 409,
    json: { ok: false, error: '冲突', conflict: { baseVersion: 42, currentVersion: 99, changedIds: ['sc1000'] } } }))
  await goto(page)
  const first = await editTitle(page, '已提交到草稿的修改')
  await first.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('button', { name: '影响预览', exact: true }).click()
  await expect(page.getByTestId('scene-impact-result')).toBeVisible()
  const second = await editTitle(page, '新修改不会丢失')
  await second.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('button', { name: '维护工具', exact: true }).click()
  await expect(page.getByTestId('scene-impact-result')).toHaveCount(0)
  await expect(page.getByTestId('scene-impact')).toContainText('旧预览已失效')
  await page.getByRole('button', { name: '保存到项目', exact: true }).click()
  await expect(page.locator('#maintenanceHint')).toContainText('先导出本地草稿')
  await expect(page.locator('#maintenanceHint')).toContainText('sc1000')
  await expect(page.getByRole('button', { name: '保存到项目', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: /^场景库/ }).click()
  await expect(page.getByRole('region', { name: '场景详情', exact: true })).toContainText('新修改不会丢失')
})

test('a form edited while saving remains open and dirty after the response', async ({ page }) => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let requested = false
  await page.route('**/api/maintenance/scenes/changes', async route => {
    requested = true
    await pending
    await route.fulfill({ json: { ok: true, count: 3, version: 43, snapshot: baseline(), backup: 'isolated-fixture' } })
  })
  await goto(page)
  const first = await editTitle(page, '发送中的草稿')
  await first.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('button', { name: '保存到项目', exact: true }).click()
  await expect.poll(() => requested).toBe(true)
  const second = await editTitle(page, '继续输入的内容')
  release()
  await expect(page.locator('#maintenanceHint')).toContainText('保存期间有新修改')
  await expect(second.getByLabel('标题 *', { exact: true })).toHaveValue('继续输入的内容')
  await expect(page.locator('#maintenanceTitle')).toHaveText('有尚未保存的修改')
})

test('consecutive copies keep sc1000+ IDs complete through the editor and search', async ({ page }) => {
  await goto(page)
  const catalog = page.locator('.maintenance-catalog:visible')
  for (const id of ['sc1001', 'sc1002']) {
    if (await catalog.locator('.inspector-more').getAttribute('open') === null) await catalog.locator('.inspector-more summary').click()
    await catalog.getByRole('button', { name: '复制为新记录', exact: true }).click()
    await expect(page.getByRole('dialog').getByLabel('ID', { exact: true })).toHaveValue(id)
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click()
  }
  await page.getByRole('searchbox', { name: '搜索管理场景' }).fill('sc1002')
  await expect(catalog.locator('.catalog-record')).toHaveCount(1)
  await expect(page.getByRole('region', { name: '场景详情', exact: true })).toContainText('sc1002')
})

test('packaged desktop stays read-only while complete export remains available', async ({ page }) => {
  await page.addInitScript(() => { window.desktopCapabilitiesFixture = { isPackaged: async () => true } as never })
  await goto(page)
  await expect(page.locator('.manager-readonly')).toBeVisible()
  await expect(page.getByRole('button', { name: '桌面模式不可保存', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '影响预览', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '导出 JSON', exact: true })).toBeEnabled()
})

test('a denied writable snapshot never falls back to cached full saves', async ({ page }) => {
  await page.route('**/api/maintenance/scenes-state', route => route.fulfill({ status: 403, json: { ok: false, error: '仅限授权本机维护' } }))
  await goto(page)
  await expect(page.locator('#maintenanceHint')).toContainText('仅限授权本机维护')
  await expect(page.getByRole('button', { name: '保存到项目', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '影响预览', exact: true })).toBeDisabled()
})

test.beforeEach(async ({ page }) => { await installDesktopHostFixture(page) })

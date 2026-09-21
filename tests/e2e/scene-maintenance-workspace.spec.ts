import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { CompanionDesktopBridge } from '../../src/types/desktop'
import type { SceneChangesPayload, SceneDraft, SceneMaintenanceSnapshot } from '../../src/types/api'
import { GUEST_GUIDE_DISMISSED_KEY, THEME_KEY } from '../../src/utils/storageKeys'

const base = process.env.AICS_UI_AUDIT_URL || ''
test.use({ serviceWorkers: 'block' })
const scene = (id: string): SceneDraft => ({
  id, title: '维护测试记录 ' + id, category: '日常', char: 'nene', rating: 'All', mature: false,
  story: '仅用于场景维护界面回归的中性记录。', storyJa: '', lora: '', emotion: '', season: '',
  time: '', timeOfDay: '', location: '', weather: '', camera: '', lighting: '', tags: [], usage: [],
  prompt: ' fixture  prompt\nline two ', negative: 'fixture negative', animaCaption: 'fixture caption',
  recommendedSize: '832x1216', extension: { untouched: true },
})
const fixture = (): SceneMaintenanceSnapshot => ({
  scenes: [...Array.from({ length: 8 }, (_, i) => scene('sc' + String(i + 1).padStart(3, '0'))), scene('sc999')],
  tags: [], curation: {},
  blueprints: [{ id: 'bp_fixture', title: '维护蓝图', category: '日常', description: '中性测试夹具',
    characterId: 'nene', location: '', action: '', timeOfDay: '', lighting: '', camera: '', mood: '',
    recommendedSize: '832x1216', promptProse: 'fixture',
    promptTokens: ['fixture'], negativeTokens: ['fixture'], sceneTags: [], sampleRating: 'All', adult: false }],
})

test.beforeEach(async ({ page }) => {
  const snapshot = fixture()
  // Register the deny rule first: only later, explicit mocks may handle requests.
  // This covers legacy /scenes, /changes, /import, /preview and other write endpoints.
  await page.route('**/api/**', route => route.fulfill({ status: 403,
    json: { ok: false, error: 'Unmocked API forbidden', code: 'SCENE_TEST_NETWORK_BLOCKED' } }))
  await page.route('**/api/maintenance/scenes-state', route => route.fulfill({ json: {
    ok: true, version: 42, nextSceneId: 'sc1000', sceneCount: snapshot.scenes.length, retiredCount: 0, snapshot,
  } }))
  await page.route('**/api/maintenance/home-hero', route => route.fulfill({ json: { ok: true, version: 1, entries: {} } }))
  if (base) {
    await page.route(/\/(data|assets|scene-showcase)\//, async route => {
      if (new URL(route.request().url()).searchParams.has('import')) return route.continue()
      const path = decodeURIComponent(new URL(route.request().url()).pathname).slice(1)
      if (!/^(data|assets|scene-showcase)\//.test(path)) return route.continue()
      if (path.includes('..')) return route.abort()
      try { await route.fulfill({ path: resolve(path) }) } catch { await route.fulfill({ status: 404 }) }
    })
  }
  // Packaged mode reads the store rather than scenes-state; it uses the same fixture.
  await page.route('**/data/**', route => {
    const file = new URL(route.request().url()).pathname.split('/').pop()!
    const data: Record<string, unknown> = {
      'scenes.json': snapshot.scenes, 'scenes-nene.json': snapshot.scenes, 'scenes-core.json': snapshot.scenes,
      'characters.json': [], 'popular-characters.json': { characters: [] }, 'scenes-index.json': {},
      'scene-blueprints.json': { blueprints: snapshot.blueprints }, 'tags.json': snapshot.tags, 'curation.json': snapshot.curation,
    }
    return route.fulfill({ json: data[file] ?? [] })
  })
  await page.addInitScript(key => {
    localStorage.setItem(key, '1')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { (window as unknown as { maintenanceCopy: string }).maintenanceCopy = value } } })
  }, GUEST_GUIDE_DISMISSED_KEY)
})

test('consecutive copies get distinct IDs and cancelling reload keeps the local draft', async ({ page }) => {
  await page.goto(base + '/scene-manager')
  const catalog = page.locator('.maintenance-catalog:visible')
  const ids: string[] = []
  for (let index = 0; index < 2; index++) {
    if (await catalog.locator('.inspector-more').getAttribute('open') === null) await catalog.locator('.inspector-more summary').click()
    await catalog.getByRole('button', { name: '复制为新记录', exact: true }).click()
    const modal = page.getByRole('dialog')
    ids.push(await modal.locator('input').first().inputValue())
    await modal.getByRole('button', { name: '取消', exact: true }).click()
  }
  expect(ids).toEqual(['sc1000', 'sc1001'])
  await page.getByRole('button', { name: '重新读取', exact: true }).click()
  const confirmation = page.getByRole('alertdialog')
  await expect(confirmation).toContainText('未保存的修改')
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.locator('.maintenance-state')).toHaveClass(/dirty/)
  await page.getByRole('searchbox', { name: '搜索管理场景' }).fill('sc1001')
  await expect(catalog.locator('.catalog-record')).toHaveCount(1)
})

for (const [theme, width, height] of [['dark', 1440, 960], ['light', 1280, 800], ['dark', 1024, 800], ['dark', 2560, 1440], ['light', 2560, 1440]] as const) {
  test(`scene maintenance workspace ${theme} ${width}`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width, height })
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: THEME_KEY, value: theme })
    await page.goto(base + '/scene-manager')
    const catalog = page.locator('.maintenance-catalog:visible')
    await expect(catalog.locator('.catalog-record').first()).toBeVisible()
    await page.getByRole('searchbox', { name: '搜索管理场景' }).fill('sc005')
    await expect(catalog.locator('.catalog-record')).toHaveCount(1)
    await expect(page.getByRole('region', { name: '场景详情', exact: true })).toContainText('sc005')
    await page.screenshot({ path: testInfo.outputPath(`scene-maintenance-${theme}.png`), fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    const workspace = await catalog.locator('.catalog-workspace').boundingBox()
    expect(workspace!.y + workspace!.height).toBeLessThanOrEqual(height)
    await catalog.getByRole('button', { name: '提示词', exact: true }).click()
    await expect(catalog.locator('.inspector-prompt').first()).toBeVisible()
    await catalog.getByRole('button', { name: '复制 JSON', exact: true }).click()
    const copied = await page.evaluate(() => JSON.parse((window as unknown as { maintenanceCopy: string }).maintenanceCopy) as { id: string })
    expect(copied.id).toBe('sc005')
    await page.getByRole('button', { name: /蓝图库/ }).click()
    await expect(catalog.locator('.catalog-record').first()).toBeVisible()
    await page.getByRole('button', { name: /^场景库/ }).click()
    await expect(page.getByRole('searchbox', { name: '搜索管理场景' })).toHaveValue('sc005')
    await catalog.getByRole('button', { name: '清除筛选' }).click()
    await catalog.locator('.catalog-record').first().focus()
    await page.keyboard.press('ArrowDown')
    await expect(catalog.locator('.catalog-record').nth(1)).toBeFocused()
    await expect(catalog.locator('.catalog-record').nth(1)).toHaveAttribute('aria-pressed', 'true')
    expect(errors).toEqual([])
  })
}

test('packaged desktop can inspect records without enabling writes', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.companionDesktop = {
      isDesktop: true, isPackaged: async () => true,
      getWindowState: async () => ({ maximized: false, focused: true }),
      onMaximizedChanged: () => 1, offMaximizedChanged: () => {},
    } as unknown as CompanionDesktopBridge
  })
  await page.goto(base + '/scene-manager')
  await expect(page.locator('.manager-readonly')).toBeVisible()
  const catalog = page.locator('.maintenance-catalog:visible')
  await expect(catalog.locator('.catalog-record').first()).toBeVisible()
  await catalog.locator('.catalog-record').nth(1).click()
  await expect(catalog.getByRole('button', { name: '编辑', exact: true })).toBeDisabled()
  await expect(catalog.getByRole('button', { name: '新增场景' })).toBeDisabled()
  await catalog.getByRole('button', { name: '提示词', exact: true }).click()
  await expect(catalog.locator('.inspector-prompt').first()).toBeVisible()
  await expect(catalog.getByRole('button', { name: '复制 JSON' })).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('desktop-scene-maintenance.png'), fullPage: true })
})

test('editing a title preserves prompt data and uses the change-set save contract', async ({ page }) => {
  let saved: SceneChangesPayload | undefined
  await page.route('**/api/maintenance/scenes/changes', async route => {
    saved = route.request().postDataJSON() as SceneChangesPayload
    const snapshot = fixture()
    snapshot.scenes = snapshot.scenes.map(item => {
      const changed = saved!.changeSet.scenes.upsert.find(candidate => candidate.id === item.id)
      return changed ? { ...changed, title: '服务端规范化标题' } : item
    })
    await route.fulfill({ json: { ok: true, count: snapshot.scenes.length, backup: 'workspace-test-backup', version: 43, snapshot } })
  })
  await page.goto(base + '/scene-manager')
  const catalog = page.locator('.maintenance-catalog:visible')
  await catalog.getByRole('button', { name: '复制 JSON' }).click()
  const original = await page.evaluate(() => JSON.parse((window as unknown as { maintenanceCopy: string }).maintenanceCopy) as SceneDraft)
  await catalog.getByRole('button', { name: '编辑', exact: true }).click()
  await page.getByLabel('标题 *', { exact: true }).fill('维护布局回归测试标题')
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click()
  await expect(catalog.locator('h2')).toHaveText('维护布局回归测试标题')
  await page.getByRole('button', { name: '保存到项目', exact: true }).click()
  await expect(page.locator('.maintenance-state')).not.toHaveClass(/dirty/)
  await expect(catalog.locator('h2')).toHaveText('服务端规范化标题')
  expect(Object.keys(saved!)).toEqual(['baseVersion', 'changeSet'])
  expect(saved?.baseVersion).toBe(42)
  expect(saved?.changeSet.scenes.upsert).toHaveLength(1)
  expect(saved?.changeSet.scenes.remove).toEqual([])
  expect(saved?.changeSet.blueprints).toBeUndefined()
  expect(saved?.changeSet.tags).toBeUndefined()
  const updated = saved?.changeSet.scenes.upsert.find(scene => scene.id === original.id)
  expect(updated?.title).toBe('维护布局回归测试标题')
  for (const field of ['prompt', 'negative', 'animaCaption', 'recommendedSize', 'rating', 'mature']) expect(updated?.[field]).toEqual(original[field])
})

test('unmatched scene writes are rejected locally for every endpoint and query string', async ({ page }) => {
  await page.goto(base + '/scene-manager')
  const results = await page.evaluate(async () => {
    const endpoints = ['/api/maintenance/scenes', '/api/maintenance/scenes/changes', '/api/maintenance/scenes/import',
      '/api/maintenance/scenes/preview', '/api/maintenance/scenes/changes?probe=1', '/api/maintenance/run']
    return Promise.all(endpoints.map(async endpoint => {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      return { status: response.status, code: (await response.json()).code }
    }))
  })
  expect(results).toEqual(Array(6).fill({ status: 403, code: 'SCENE_TEST_NETWORK_BLOCKED' }))
})

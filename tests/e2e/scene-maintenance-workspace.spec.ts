import { expect, test, type Page } from '@playwright/test'
import type { CatalogChange, CatalogReceipt, CatalogRecord } from '../../src/api/catalogApi'
import { THEME_KEY } from '../../src/utils/storageKeys'
import { catalogScene, installCatalogReads } from './helpers/catalogReads'

test.use({ serviceWorkers: 'block' })
const url = (baseURL: string | undefined) => (process.env.AICS_UI_AUDIT_URL || baseURL!) + '/scene-manager'
const records = (): CatalogRecord[] => [
  ...Array.from({ length: 8 }, (_, i) => catalogScene('sc' + String(i + 1).padStart(3, '0'))), catalogScene('sc999'),
  { kind: 'blueprint', id: 'bp_fixture', revision: 1, sortOrder: 0, createdAt: null, updatedAt: null,
    data: { id: 'bp_fixture', title: '维护蓝图', category: '日常', description: '中性测试夹具', characterId: 'nene',
      promptProse: 'fixture', promptTokens: ['fixture'], negativeTokens: ['fixture'], sceneTags: [],
      recommendedSize: '832x1216', sampleRating: 'All', adult: false } },
]
async function prepare(page: Page, baseURL: string | undefined) {
  const state = { records: records(), version: 42 }
  await installCatalogReads(page, state, url(baseURL))
  return state
}

for (const [theme, width, height] of [['dark', 1440, 960], ['light', 1280, 800], ['dark', 1024, 800], ['dark', 2560, 1440], ['light', 2560, 1440]] as const) {
  test(`scene maintenance workspace ${theme} ${width}`, async ({ page, baseURL }, testInfo) => {
    await prepare(page, baseURL)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width, height })
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: THEME_KEY, value: theme })
    await page.goto(url(baseURL))
    const library = page.getByRole('region', { name: '内容列表', exact: true })
    const rows = library.locator('.catalog-record-row')
    const search = page.getByRole('searchbox', { name: '搜索内容', exact: true })
    await expect(rows.first()).toBeVisible()
    await search.fill('sc005')
    await expect(rows).toHaveCount(1)
    await rows.first().click()
    const editor = page.getByRole('region', { name: '编写内容', exact: true })
    await expect(editor.getByLabel('标题', { exact: true })).toHaveValue('场景记录 · sc005')
    await editor.getByText('绘制时使用的画面描述', { exact: true }).click()
    await expect(editor.getByLabel('画面描述', { exact: true })).toHaveValue(' fixture  prompt\nline two ')
    await editor.getByText('完整数据与扩展设置', { exact: true }).click()
    expect(JSON.parse(await editor.getByRole('textbox', { name: '完整内容数据', exact: true }).inputValue())).toEqual(catalogScene('sc005').data)
    await page.screenshot({ path: testInfo.outputPath(`scene-maintenance-${theme}.png`), fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)

    // Current categories share the search term; changing category never silently discards it.
    const categories = page.getByRole('complementary', { name: '内容分类' })
    await categories.getByRole('button', { name: /^场景蓝图/ }).click()
    await expect(search).toHaveValue('sc005')
    await expect(rows).toHaveCount(0)
    await search.fill('')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('维护蓝图')
    await categories.getByRole('button', { name: /^场景故事/ }).click()
    await expect(search).toHaveValue('')
    await expect(rows).toHaveCount(9)
    // The record list uses native buttons, so Tab moves focus and Enter selects.
    await rows.first().focus()
    await page.keyboard.press('Tab')
    await expect(rows.nth(1)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'true')
    await expect(editor.getByLabel('标题', { exact: true })).toHaveValue('场景记录 · sc002')
    expect(errors).toEqual([])
  })
}

test('editing a title preserves all prompt data and reloads the server-normalized catalog record', async ({ page, baseURL }) => {
  const state = await prepare(page, baseURL)
  const original = catalogScene('sc001')
  const submissions: Array<{ changes: CatalogChange[]; preview: boolean }> = []
  await page.route('**/api/catalog/changes', async route => {
    expect(route.request().method()).toBe('POST')
    const body: typeof submissions[number] = route.request().postDataJSON()
    submissions.push(body)
    const after: CatalogRecord = { ...original, revision: original.revision + 1,
      data: { ...body.changes[0]?.data, title: '服务端规范化标题' } }
    state.records = state.records.map(item => item.kind === after.kind && item.id === after.id ? after : item)
    state.version++
    const receipt: CatalogReceipt = { ok: true, preview: false, version: state.version, batch: 'workspace-test-batch',
      items: [{ kind: after.kind, id: after.id, revision: after.revision, removed: false }],
      diffs: [{ kind: after.kind, id: after.id, before: original, after }] }
    await route.fulfill({ json: receipt })
  })
  await page.goto(url(baseURL))
  const rows = page.getByRole('region', { name: '内容列表', exact: true }).locator('.catalog-record-row')
  await rows.first().click()
  const editor = page.getByRole('region', { name: '编写内容', exact: true })
  await editor.getByLabel('标题', { exact: true }).fill('维护布局回归测试标题')
  await editor.getByRole('button', { name: '暂存修改', exact: true }).click()
  await expect(editor.getByRole('heading', { level: 2 })).toHaveText('维护布局回归测试标题')
  await page.getByRole('button', { name: '保存更改', exact: true }).click()
  await expect(page.locator('.catalog-save-status')).not.toHaveClass(/has-changes/)
  await expect(rows.first()).toContainText('服务端规范化标题')
  await rows.first().click()
  await expect(editor.getByLabel('标题', { exact: true })).toHaveValue('服务端规范化标题')
  // Exact equality also preserves whitespace in prompt/negative/caption and the rating/extension fields.
  expect(submissions).toEqual([{ preview: false, changes: [{ kind: 'scene', id: original.id,
    expectedRevision: original.revision, sortOrder: original.sortOrder,
    data: { ...original.data, title: '维护布局回归测试标题' } }] }])
})

import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import type { CatalogChange, CatalogKind, CatalogReceipt, CatalogRecord, CatalogSnapshot } from '../../src/api/catalogApi'
import { THEME_KEY } from '../../src/utils/storageKeys'
import { catalogScene, installCatalogReads } from './helpers/catalogReads'

test.use({ serviceWorkers: 'block' })

const record = (kind: CatalogKind, id: string, data: CatalogRecord['data']): CatalogRecord =>
  ({ kind, id, data, revision: 1, sortOrder: 0, createdAt: null, updatedAt: null })
const blueprint = (id: string) => record('blueprint', id, { id, title: '蓝图记录 · ' + id, characterId: 'nene',
  category: '日常', description: '隔离验证', promptProse: 'fixture', promptTokens: ['fixture'], negativeTokens: ['fixture'],
  sceneTags: [], recommendedSize: '832x1216', adult: false, sampleRating: 'All' })
const tags = [{ id: 't1', en: 'fixture', cn: '测试标签', cat: 'Scene', weight: 1 }]
const baseline = () => [catalogScene('sc998'), catalogScene('sc999'), catalogScene('sc1000'), blueprint('bp_001'),
  record('document', 'tags', []), record('document', 'curation', { reviewSceneIds: ['sc999'] })]
const changes = (): CatalogChange[] => [
  { kind: 'scene', id: 'sc998', expectedRevision: 1, sortOrder: 998, data: catalogScene('sc998', '修改后的场景').data },
  { kind: 'scene', id: 'sc999', expectedRevision: 1, remove: true },
  { kind: 'scene', id: 'sc1001', expectedRevision: 0, sortOrder: 1001, data: catalogScene('sc1001', '新增场景').data },
  { kind: 'blueprint', id: 'bp_001', expectedRevision: 1, remove: true },
  { kind: 'blueprint', id: 'bp_002', expectedRevision: 0, sortOrder: 0, data: blueprint('bp_002').data },
  { kind: 'document', id: 'tags', expectedRevision: 1, data: tags },
  { kind: 'document', id: 'curation', expectedRevision: 1, data: {} },
]
const snapshot = (): CatalogSnapshot => ({ version: 1,
  records: [catalogScene('sc998', '修改后的场景'), catalogScene('sc1000'), catalogScene('sc1001', '新增场景'), blueprint('bp_002'),
    record('document', 'tags', tags), record('document', 'curation', {})],
  retired: [catalogScene('sc999'), blueprint('bp_001')] })
function receipt(submission: CatalogChange[], preview: boolean, records = baseline()): CatalogReceipt {
  const diffs = submission.map(change => {
    const before = records.find(item => item.kind === change.kind && item.id === change.id) ?? null
    const after: CatalogRecord | null = change.remove ? null : { kind: change.kind, id: change.id,
      revision: (before?.revision ?? 0) + 1, sortOrder: change.sortOrder ?? before?.sortOrder ?? 0,
      createdAt: before?.createdAt ?? null, updatedAt: null, data: change.data ?? before?.data ?? {} }
    return { kind: change.kind, id: change.id, before, after }
  })
  return { ok: true, preview, version: preview ? 42 : 43, batch: 'isolated-catalog-fixture', diffs,
    items: diffs.map(diff => ({ kind: diff.kind, id: diff.id, revision: diff.after?.revision ?? (diff.before?.revision ?? 0) + 1, removed: !diff.after })) }
}
const url = (baseURL: string | undefined) => process.env.AICS_SCENE_UI_TEST_URL || (process.env.AICS_UI_AUDIT_URL || baseURL!) + '/scene-manager'
async function prepare(page: Page, baseURL: string | undefined) {
  const state = { records: baseline(), version: 42 }
  await installCatalogReads(page, state, url(baseURL))
  return state
}
async function stageBulk(page: Page, value: { changes: CatalogChange[] } | CatalogSnapshot) {
  await page.getByRole('complementary', { name: '内容分类' }).getByRole('button', { name: '批量整理', exact: true }).click()
  await page.getByText('直接填写修改数据', { exact: true }).click()
  await page.getByRole('textbox', { name: '修改数据', exact: true }).fill(JSON.stringify(value))
  await page.getByRole('button', { name: '读取这些修改', exact: true }).click()
}
async function openScene(page: Page, id = 'sc1000') {
  await page.getByRole('complementary', { name: '内容分类' }).getByRole('button', { name: /^场景故事/ }).click()
  await page.getByRole('searchbox', { name: '搜索内容', exact: true }).fill(id)
  const rows = page.getByRole('region', { name: '内容列表', exact: true }).locator('.catalog-record-row')
  await expect(rows).toHaveCount(1)
  await expect(page.getByRole('region', { name: '内容列表', exact: true })).toHaveAttribute('aria-busy', 'false')
  await rows.first().click()
  const editor = page.getByRole('region', { name: '编写内容', exact: true })
  await expect(editor).toBeVisible()
  return editor
}
async function stageTitle(page: Page, title: string) {
  const editor = await openScene(page)
  await editor.getByLabel('标题', { exact: true }).fill(title)
  await editor.getByRole('button', { name: '暂存修改', exact: true }).click()
  return editor
}
async function downloadJson(page: Page, label: string): Promise<unknown> {
  await page.getByRole('button', { name: '更多整理操作', exact: true }).click()
  const waiting = page.waitForEvent('download')
  await page.getByRole('button', { name: label, exact: true }).click()
  const file = await (await waiting).path()
  if (!file) throw new Error('Expected the isolated catalog download to be available')
  return JSON.parse(await readFile(file, 'utf8'))
}

for (const theme of ['dark', 'light'] as const) {
  test(`catalog preview ${theme} 1440: text, keyboard, contrast and layout`, async ({ page, baseURL }, testInfo) => {
    await prepare(page, baseURL)
    let previews = 0
    await page.route('**/api/catalog/changes', route => { previews++; return route.fulfill({ json: receipt(changes(), true) }) })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: THEME_KEY, value: theme })
    await page.goto(url(baseURL))
    await stageBulk(page, { changes: changes() })
    const review = page.getByRole('button', { name: '查看修改', exact: true })
    await review.click()
    const panel = page.getByRole('region', { name: '修改预览', exact: true })
    await expect(panel).toContainText('修改后的场景')
    await expect(panel).toContainText('场景记录 · sc999')
    await expect(panel).toContainText('蓝图记录 · bp_002')
    await expect(panel).toContainText('新加入')
    await expect(panel).toContainText('将归档')
    await review.focus()
    await expect(review).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(() => previews).toBe(2)
    await expect(panel).toBeVisible()
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
    await page.screenshot({ path: testInfo.outputPath(`catalog-preview-${theme}-1440.png`), fullPage: true })
    expect(errors).toEqual([])
  })
}

test('preview posts the exact staged record changes without committing or importing', async ({ page, baseURL }) => {
  await prepare(page, baseURL)
  const requests: Array<{ path: string; body: unknown }> = []
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (request.method() !== 'GET' && path.startsWith('/api/catalog')) requests.push({ path, body: request.postDataJSON() })
  })
  await page.route('**/api/catalog/changes', route => route.fulfill({ json: receipt(changes(), true) }))
  await page.goto(url(baseURL))
  await stageBulk(page, { changes: changes() })
  await page.getByRole('button', { name: '查看修改', exact: true }).click()
  await expect(page.getByRole('region', { name: '修改预览', exact: true })).toBeVisible()
  expect(requests).toEqual([{ path: '/api/catalog/changes', body: { changes: changes(), preview: true } }])
  await expect(page.locator('.catalog-save-status')).toHaveClass(/has-changes/)
})

test('full import uses its own endpoint and cannot commit before an explicit preview', async ({ page, baseURL }) => {
  await prepare(page, baseURL)
  const bodies: unknown[] = []
  await page.route('**/api/catalog/import', route => {
    const body: { snapshot: CatalogSnapshot; preview: boolean } = route.request().postDataJSON()
    bodies.push(body)
    return route.fulfill({ json: receipt(changes(), body.preview) })
  })
  await page.goto(url(baseURL))
  await stageBulk(page, snapshot())
  const confirm = page.getByRole('button', { name: '确认导入', exact: true })
  await expect(confirm).toBeDisabled()
  await page.getByRole('button', { name: '看看导入的变化', exact: true }).click()
  await expect(page.getByRole('region', { name: '修改预览', exact: true })).toBeVisible()
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect(page.locator('.catalog-feedback')).toHaveText('快照已导入；本地修改与冲突按记录核对')
  expect(bodies).toEqual([{ snapshot: snapshot(), preview: true }, { snapshot: snapshot(), preview: false }])
})

for (const operation of ['preview', 'import'] as const) {
  test(`${operation} conflicts preserve the complete draft and display the server error`, async ({ page, baseURL }) => {
    await prepare(page, baseURL)
    const rejected = { ok: false, code: 'CATALOG_CONFLICT', error: '内容有新修订，请先核对最新版本' }
    if (operation === 'preview') {
      await page.route('**/api/catalog/changes', route => route.fulfill({ status: 409, json: rejected }))
    } else {
      await page.route('**/api/catalog/import', route => {
        const body: { preview: boolean } = route.request().postDataJSON()
        return body.preview ? route.fulfill({ json: receipt(changes(), true) }) : route.fulfill({ status: 409, json: rejected })
      })
    }
    await page.goto(url(baseURL))
    await stageBulk(page, operation === 'preview' ? { changes: changes() } : snapshot())
    if (operation === 'preview') await page.getByRole('button', { name: '查看修改', exact: true }).click()
    else {
      await page.getByRole('button', { name: '看看导入的变化', exact: true }).click()
      await page.getByRole('button', { name: '确认导入', exact: true }).click()
    }
    await expect(page.locator('.catalog-feedback')).toHaveText(rejected.error)
    await expect(page.getByRole('region', { name: '修改预览', exact: true })).toHaveCount(0)
    if (operation === 'preview') {
      await expect(page.locator('.catalog-save-status')).toHaveClass(/has-changes/)
      expect(await downloadJson(page, '备份未保存的修改')).toEqual({ changes: changes(), editor: null })
    } else {
      await expect(page.getByRole('textbox', { name: '修改数据', exact: true })).toHaveValue(JSON.stringify(snapshot()))
      await expect(page.getByRole('button', { name: '确认导入', exact: true })).toBeDisabled()
      await expect(page.getByRole('button', { name: '看看导入的变化', exact: true })).toBeEnabled()
    }
  })
}

test('editing invalidates the preview and a revision conflict preserves the draft', async ({ page, baseURL }) => {
  const state = await prepare(page, baseURL)
  const original = catalogScene('sc1000')
  const first = { kind: 'scene' as const, id: original.id, expectedRevision: 1, sortOrder: original.sortOrder,
    data: { ...original.data, title: '已提交到草稿的修改' } }
  await page.route('**/api/catalog/changes', route => {
    const body: { changes: CatalogChange[]; preview: boolean } = route.request().postDataJSON()
    if (body.preview) return route.fulfill({ json: receipt([first], true) })
    state.records = state.records.map(item => item.id === original.id ? { ...item, revision: 2, data: { ...item.data, title: '其他窗口的内容' } } : item)
    return route.fulfill({ status: 409, json: { ok: false, code: 'CATALOG_CONFLICT', error: 'sc1000 已在其他窗口更新' } })
  })
  await page.goto(url(baseURL))
  const editor = await stageTitle(page, '已提交到草稿的修改')
  await page.getByRole('button', { name: '查看修改', exact: true }).click()
  await expect(page.getByRole('region', { name: '修改预览', exact: true })).toBeVisible()
  await editor.getByLabel('标题', { exact: true }).fill('新修改不会丢失')
  await editor.getByRole('button', { name: '暂存修改', exact: true }).click()
  await expect(page.getByRole('region', { name: '修改预览', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '保存更改', exact: true }).click()
  await expect(page.locator('.catalog-feedback')).toHaveText('sc1000 已在其他窗口更新')
  await expect(page.locator('.catalog-conflict')).toContainText('其他窗口的内容')
  await expect(editor.getByLabel('标题', { exact: true })).toHaveValue('新修改不会丢失')
  await expect(page.locator('.catalog-save-status')).toHaveClass(/has-changes/)
  const expected = { ...first, data: { ...original.data, title: '新修改不会丢失' } }
  expect(await downloadJson(page, '备份未保存的修改')).toEqual({ changes: [expected], editor: { ...original, data: expected.data } })
})

test('saving locks editing and keeps the submitted record stable until completion', async ({ page, baseURL }) => {
  const state = await prepare(page, baseURL)
  const original = catalogScene('sc1000')
  const expected = { kind: 'scene' as const, id: original.id, expectedRevision: 1, sortOrder: original.sortOrder,
    data: { ...original.data, title: '发送中的草稿' } }
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const bodies: unknown[] = []
  await page.route('**/api/catalog/changes', async route => {
    bodies.push(route.request().postDataJSON())
    await pending
    state.records = state.records.map(item => item.id === original.id ? { ...item, revision: 2, data: expected.data } : item)
    state.version++
    await route.fulfill({ json: receipt([expected], false) })
  })
  await page.goto(url(baseURL))
  const editor = await stageTitle(page, '发送中的草稿')
  await page.getByRole('button', { name: '保存更改', exact: true }).click()
  try {
    await expect.poll(() => bodies.length).toBe(1)
    await expect(editor.getByLabel('标题', { exact: true })).toBeDisabled()
    await expect(editor.getByLabel('标题', { exact: true })).toHaveValue('发送中的草稿')
    await expect(editor.getByRole('button', { name: '暂存修改', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '新建场景故事', exact: true })).toBeDisabled()
    expect(bodies).toEqual([{ changes: [expected], preview: false }])
  } finally { release() }
  await expect(page.locator('.catalog-feedback')).toHaveText('已保存 1 项修改')
  await expect(page.locator('.catalog-save-status')).not.toHaveClass(/has-changes/)
  await expect(page.getByRole('button', { name: '保存更改', exact: true })).toBeDisabled()
  await expect((await openScene(page)).getByLabel('标题', { exact: true })).toHaveValue('发送中的草稿')
})

test('consecutive staged copies keep sc1000+ IDs complete across refresh', async ({ page, baseURL }) => {
  await prepare(page, baseURL)
  await page.goto(url(baseURL))
  const editor = await openScene(page)
  const expected: CatalogChange[] = []
  for (const id of ['sc1001', 'sc1002']) {
    await editor.getByRole('button', { name: '复制一份', exact: true }).click()
    await expect(editor.getByLabel('内部编号')).toHaveValue(id)
    await editor.getByLabel('标题', { exact: true }).fill('复制记录 ' + id)
    await editor.getByRole('button', { name: '暂存修改', exact: true }).click()
    expected.push({ kind: 'scene', id, expectedRevision: 0, sortOrder: 1000, data: { ...catalogScene('sc1000').data, id, title: '复制记录 ' + id } })
  }
  await page.getByRole('button', { name: '更多整理操作', exact: true }).click()
  await page.getByRole('button', { name: '刷新内容', exact: true }).click()
  await expect(page.locator('.catalog-review-area')).toContainText('复制记录 sc1001')
  await expect(page.locator('.catalog-review-area')).toContainText('复制记录 sc1002')
  await expect(page.locator('.catalog-save-status')).toHaveClass(/has-changes/)
  await page.getByRole('heading', { name: '场景故事', exact: true }).click()
  expect(await downloadJson(page, '备份未保存的修改')).toEqual({ changes: expected,
    editor: { ...catalogScene('sc1000'), id: 'sc1002', revision: 0, data: expected[1].data } })
})

test('desktop host preserves an editable draft through cancelled navigation while full export stays authoritative', async ({ page, baseURL }) => {
  await prepare(page, baseURL)
  await page.addInitScript(() => { window.desktopCapabilitiesFixture = { isDesktop: true } })
  await page.goto(url(baseURL))
  await expect(page.getByRole('button', { name: '保存更改', exact: true })).toBeDisabled()
  const editor = await stageTitle(page, '桌面本地草稿')
  await expect(page.getByRole('button', { name: '保存更改', exact: true })).toBeEnabled()
  await page.locator('.nav-links a[href="/scene-explorer"]').click()
  await page.getByRole('alertdialog', { name: '离开内容维护？', exact: true }).getByRole('button', { name: '取消', exact: true }).click()
  await expect(page).toHaveURL(/\/scene-manager$/)
  await expect(editor.getByLabel('标题', { exact: true })).toHaveValue('桌面本地草稿')
  await expect(page.getByRole('button', { name: '保存更改', exact: true })).toBeEnabled()
  expect(await downloadJson(page, '导出全部内容')).toEqual({ version: 1, records: baseline(), retired: [] })
})

test('a denied catalog never falls back to cached scene data or submits writes', async ({ page, baseURL }) => {
  await prepare(page, baseURL)
  const writes: string[] = []
  page.on('request', request => { if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/catalog')) writes.push(request.url()) })
  await page.route(/\/api\/catalog\?/, route => route.fulfill({ status: 403, json: { ok: false, error: '仅限授权本机维护' } }))
  await page.goto(url(baseURL))
  await expect(page.getByRole('region', { name: '内容列表', exact: true })).toContainText('仅限授权本机维护')
  await expect(page.locator('.catalog-record-row')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '保存更改', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '查看修改', exact: true })).toHaveCount(0)
  expect(writes).toEqual([])
})

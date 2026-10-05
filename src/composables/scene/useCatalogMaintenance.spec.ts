import { defineComponent, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { useCatalogMaintenance } from './useCatalogMaintenance'
import type { CatalogRecord } from '@/api/catalogApi'
const mock = vi.hoisted(() => ({ query: vi.fn(), stats: vi.fn(), record: vi.fn(), history: vi.fn(), changes: vi.fn(), importSnapshot: vi.fn(), invalidate: vi.fn() }))
vi.mock('@/api/catalogApi', () => ({ catalogApi: mock, isCatalogRecord: () => true }))
vi.mock('@/stores/sceneStore', () => ({ useSceneStore: () => ({ invalidate: mock.invalidate }) }))
vi.mock('vue-router', () => ({ onBeforeRouteLeave: vi.fn() }))
vi.mock('@/composables/useConfirm', () => ({ confirmAction: async () => true }))
vi.mock('@/platform/maintenanceParticipants', () => ({ registerMaintenanceParticipant: () => () => {} }))
const record = (revision = 1, title = 'original'): CatalogRecord => ({ kind: 'scene', id: 'sc001', revision, sortOrder: 1, createdAt: null, updatedAt: null, data: { id: 'sc001', title } })
let wrapper: ReturnType<typeof mount>
function setup() {
  let flow!: ReturnType<typeof useCatalogMaintenance>
  wrapper = mount(defineComponent({ setup() { flow = useCatalogMaintenance(); return () => null } }))
  return flow
}
beforeEach(() => {
  mock.query.mockResolvedValue({ ok: true, version: 1, items: [], total: 0, page: 1, pageSize: 24, facets: { characters: [], categories: [], ratings: [] } })
  mock.stats.mockResolvedValue({ counts: {}, nextSceneId: 'sc002' })
  mock.record.mockResolvedValue({ record: record() })
  mock.history.mockResolvedValue({ items: [] })
})
afterEach(() => { wrapper?.unmount(); vi.useRealTimers(); vi.resetAllMocks() })
it('keeps a pending draft revision when reopened against newer server data until the user adopts it', async () => {
  const flow = setup(); await flushPromises()
  await flow.select({ kind: 'scene', id: 'sc001' })
  ;(flow.selected.value!.data as Record<string, unknown>).title = 'draft'; flow.stage()
  ;(flow.selected.value!.data as Record<string, unknown>).title = 'not staged'
  expect((flow.pending.value[0].data as Record<string, unknown>).title).toBe('draft')
  mock.record.mockResolvedValue({ record: record(2, 'concurrent') })
  await flow.select({ kind: 'scene', id: 'sc001' })
  expect(flow.selected.value?.revision).toBe(1)
  expect(flow.pending.value[0].expectedRevision).toBe(1)
  expect(flow.currentServer.value?.revision).toBe(2)
  expect((flow.selected.value?.data as Record<string, unknown>).title).toBe('draft')
  flow.adoptRevision(); flow.stage()
  expect(flow.pending.value[0].expectedRevision).toBe(2)
})
it('preserves unsaved changes after a failed save and reads details separately from the summary', async () => {
  const flow = setup(); await flushPromises()
  expect(mock.record).not.toHaveBeenCalled()
  await flow.load()
  expect(mock.stats).toHaveBeenCalledTimes(1)
  await flow.select({ kind: 'scene', id: 'sc001' })
  ;(flow.selected.value!.data as Record<string, unknown>).title = 'draft'; flow.stage()
  mock.changes.mockRejectedValue(new Error('storage unavailable'))
  await flow.submit(false)
  expect(flow.pending.value).toHaveLength(1)
  expect(flow.hint.value).toBe('storage unavailable')
  expect(flow.busy.value).toBe(false)
  expect(mock.invalidate).not.toHaveBeenCalled()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
it('coalesces page resets and consumes a pending search debounce on explicit filtering', async () => {
  vi.useFakeTimers()
  mock.query.mockImplementation(async (query: { kind: string; page?: number }) => ({ ok: true, version: 1, items: [], total: query.kind === 'scene' ? 100 : 0, page: query.page ?? 1, pageSize: 24, facets: {} }))
  const flow = setup(); await flushPromises()
  const queries = () => mock.query.mock.calls.filter(([query]) => query.kind === 'scene')
  flow.page.value = 3; await nextTick(); await flushPromises()
  expect(queries()).toHaveLength(2)
  flow.category.value = 'new'; await nextTick(); await flushPromises()
  expect(flow.page.value).toBe(1)
  expect(queries()).toHaveLength(3)
  flow.search.value = 'term'; await nextTick()
  flow.rating.value = 'R15'; await nextTick(); await flushPromises()
  await vi.advanceTimersByTimeAsync(180)
  expect(queries()).toHaveLength(4)
  expect(queries()[3][0]).toMatchObject({ search: 'term', rating: 'R15', page: 1 })
})

it('invalidates old detail reads when creating, saving, or importing a new editor state', async () => {
  const flow = setup(); await flushPromises()
  const old = deferred<{ record: CatalogRecord }>()
  mock.record.mockReturnValueOnce(old.promise)
  const opening = flow.select({ kind: 'scene', id: 'sc001' }); await nextTick()
  await flow.add()
  old.resolve({ record: record() }); await opening
  expect(flow.selected.value?.id).toBe('sc002')
  expect(flow.detailLoading.value).toBe(false)
  expect(mock.history).not.toHaveBeenCalled()
  for (const mode of ['save', 'import']) {
    await flow.select({ kind: 'scene', id: 'sc001' })
    if (mode === 'save') flow.stage()
    else { flow.bulkInput.value = JSON.stringify({ version: 1, records: [], retired: [] }); flow.loadBulk(); flow.importPreview.value = true }
    const stale = deferred<{ record: CatalogRecord }>()
    mock.record.mockReturnValueOnce(stale.promise)
    const reading = flow.select({ kind: 'scene', id: 'sc001' }); await nextTick()
    mock.changes.mockResolvedValue({ items: [] }); mock.importSnapshot.mockResolvedValue({ items: [] })
    if (mode === 'save') await flow.submit()
    else await flow.importContent(false)
    stale.resolve({ record: record() }); await reading
    expect(flow.selected.value).toBeNull()
    expect(flow.history.value).toEqual([])
    expect(flow.detailLoading.value).toBe(false)
  }
})

it('owns bulk file reads across saves, newer files, parse errors, and unmount', async () => {
  const flow = setup(); await flushPromises()
  const raw = (id: string) => JSON.stringify({ changes: [{ kind: 'scene', id, expectedRevision: 0, data: {} }] })
  flow.bulkInput.value = raw('keep'); flow.loadBulk()
  const late = deferred<string>(), saving = deferred<{ items: [] }>()
  const reading = flow.readBulkFile({ text: () => late.promise })
  mock.changes.mockReturnValueOnce(saving.promise)
  const submit = flow.submit()
  const ignored = vi.fn(async () => raw('ignored'))
  await flow.readBulkFile({ text: ignored })
  expect(ignored).not.toHaveBeenCalled()
  saving.resolve({ items: [] }); await submit
  late.resolve(raw('stale')); await reading
  expect(flow.pending.value).toEqual([])
  const first = deferred<string>()
  const older = flow.readBulkFile({ text: () => first.promise })
  await flow.readBulkFile({ text: async () => raw('latest') })
  first.resolve(raw('old')); await older
  expect(flow.pending.value.map(change => change.id)).toEqual(['latest'])
  await flow.readBulkFile({ text: async () => '{broken' })
  expect(flow.bulkError.value).not.toBe('')
  expect(flow.bulkInput.value).toBe(raw('latest'))
  expect(flow.pending.value.map(change => change.id)).toEqual(['latest'])
  const abandoned = deferred<string>(), leaving = flow.readBulkFile({ text: () => abandoned.promise })
  wrapper.unmount(); abandoned.resolve(raw('orphan')); await leaving
  expect(flow.pending.value.map(change => change.id)).toEqual(['latest'])
})

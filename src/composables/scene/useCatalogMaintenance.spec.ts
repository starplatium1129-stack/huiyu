import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { useCatalogMaintenance } from './useCatalogMaintenance'
import type { CatalogRecord } from '@/api/catalogApi'
const mock = vi.hoisted(() => ({ query: vi.fn(), stats: vi.fn(), record: vi.fn(), history: vi.fn(), changes: vi.fn(), invalidate: vi.fn() }))
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
  mock.query.mockResolvedValue({ ok: true, items: [], total: 0, page: 1, pageSize: 24, facets: { characters: [], categories: [], ratings: [] } })
  mock.stats.mockResolvedValue({ counts: {}, nextSceneId: 'sc002' })
  mock.record.mockResolvedValue({ record: record() })
  mock.history.mockResolvedValue({ items: [] })
})
afterEach(() => { wrapper?.unmount(); vi.resetAllMocks() })
it('keeps a pending draft revision when reopened against newer server data until the user adopts it', async () => {
  const flow = setup(); await flushPromises()
  await flow.select({ kind: 'scene', id: 'sc001' })
  ;(flow.selected.value!.data as Record<string, unknown>).title = 'draft'; flow.stage()
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
  await flow.select({ kind: 'scene', id: 'sc001' })
  ;(flow.selected.value!.data as Record<string, unknown>).title = 'draft'; flow.stage()
  mock.changes.mockRejectedValue(new Error('storage unavailable'))
  await flow.submit(false)
  expect(flow.pending.value).toHaveLength(1)
  expect(flow.hint.value).toBe('storage unavailable')
  expect(flow.busy.value).toBe(false)
  expect(mock.invalidate).not.toHaveBeenCalled()
})

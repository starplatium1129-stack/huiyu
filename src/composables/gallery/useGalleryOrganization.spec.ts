import { afterEach, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useGalleryOrganization } from './useGalleryOrganization'
const mocks = vi.hoisted(() => ({ organize: vi.fn(), undo: vi.fn() }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { organizeArtworks: mocks.organize, undoArtworkOrganization: mocks.undo } }))
afterEach(() => vi.clearAllMocks())

it('freezes selection, splits bounded batches, and can undo confirmed work after a later failure', async () => {
  const ids = Array.from({ length: 450 }, (_, id) => id), changed = vi.fn(), scope = effectScope()
  const flow = scope.run(() => useGalleryOrganization({ ids: () => ids, changed }))!
  mocks.organize.mockImplementationOnce(async input => {
    ids.splice(0)
    return { operationId: 'first', changes: input.ids.map((id: number) => ({ id, before: {}, after: {} })) }
  }).mockRejectedValueOnce(new Error('second batch failed'))
  await flow.apply({ projectId: 'album' })
  expect(mocks.organize.mock.calls.map(call => call[0].ids.length)).toEqual([200, 200])
  expect(flow.error.value).toContain('已完成 200 幅')
  expect(flow.canUndo.value).toBe(true)
  mocks.undo.mockResolvedValue({ restored: 199, skipped: 1 })
  await flow.undo()
  expect(mocks.undo).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operationId: 'first' }))
  expect(flow.message.value).toContain('1 幅已有新修改')
  expect(flow.canUndo.value).toBe(false)
  expect(changed).toHaveBeenCalledTimes(2)
  scope.stop()
})

it('stops unsubmitted work after disposal and keeps confirmed receipts available', async () => {
  const scope = effectScope()
  const flow = scope.run(() => useGalleryOrganization({ ids: () => Array.from({ length: 401 }, (_, id) => id), changed: vi.fn() }))!
  mocks.organize.mockImplementationOnce(async () => { scope.stop(); return { operationId: 'accepted', changes: [{ id: 1, before: {}, after: {} }] } })
  await flow.apply({ collectionTags: { add: ['tag'] } })
  expect(mocks.organize).toHaveBeenCalledOnce()
  expect(flow.canUndo.value).toBe(true)
  expect(flow.message.value).toContain('已停止后续整理')
  expect(flow.tagsFromInput('spring, spring，旅行；封面')).toEqual(['spring', '旅行', '封面'])
})

it('rejects a selection larger than the complete undo budget before submitting anything', async () => {
  const scope = effectScope()
  const flow = scope.run(() => useGalleryOrganization({ ids: () => Array.from({ length: 12801 }, (_, id) => id), changed: vi.fn() }))!
  await flow.apply({ projectId: 'album' })
  expect(mocks.organize).not.toHaveBeenCalled()
  expect(flow.error.value).toContain('12,800')
  scope.stop()
})

import { afterEach, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useGalleryOrganization } from './useGalleryOrganization'
import { normalizeArtworkOrganization } from '@/application/artwork/organization'
const mocks = vi.hoisted(() => ({ organize: vi.fn(), undo: vi.fn(), create: vi.fn() }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { organizeArtworks: mocks.organize, undoArtworkOrganization: mocks.undo, createProject: mocks.create } }))
afterEach(() => vi.clearAllMocks())

it('retries an uncertain album creation with the same identity and keeps the original artwork selection', async () => {
  const ids = [1, 2], scope = effectScope()
  const flow = scope.run(() => useGalleryOrganization({ ids: () => ids, changed: vi.fn() }))!
  mocks.create.mockRejectedValueOnce(new Error('connection lost')).mockImplementationOnce(async draft => {
    ids.splice(0)
    return { ...draft, history_ids: [] }
  })
  mocks.organize.mockImplementationOnce(async input => ({ operationId: 'members', changes: input.ids.map((id: number) => ({ id, before: {}, after: {} })) }))
  await flow.apply({}, '秋日手记')
  const identity = flow.pendingProject.value!.id
  expect(flow.error.value).toContain('请重试本次创建')
  expect(flow.message.value).toBe('')
  expect(mocks.organize).not.toHaveBeenCalled()
  await flow.apply({}, '秋日手记')
  expect(mocks.create.mock.calls.map(([draft]) => draft.id)).toEqual([identity, identity])
  expect(mocks.organize).toHaveBeenCalledExactlyOnceWith({ ids: [1, 2], projectId: identity })
  expect(flow.createdProject.value?.title).toBe('秋日手记')
  expect(flow.pendingProject.value).toBeNull()
  expect(flow.canUndo.value).toBe(true)
  scope.stop()
})

it('freezes selection, splits bounded batches, and can undo confirmed work after a later failure', async () => {
  const ids = [0], changed = vi.fn(), scope = effectScope()
  const flow = scope.run(() => useGalleryOrganization({ ids: () => ids, changed }))!
  mocks.organize.mockResolvedValueOnce({ operationId: 'previous', changes: [{ id: 0, before: {}, after: {} }] })
  await flow.apply({ projectId: 'previous-album' })
  ids.splice(0, 1, ...Array.from({ length: 450 }, (_, id) => id))
  mocks.organize.mockImplementationOnce(async () => {
    ids.splice(0)
    return { operationId: 'noop', changes: [] }
  }).mockImplementationOnce(async input => {
    return { operationId: 'first', changes: input.ids.map((id: number) => ({ id, before: {}, after: {} })) }
  }).mockRejectedValueOnce(new Error('second batch failed'))
  await flow.apply({ projectId: 'album' })
  expect(mocks.organize.mock.calls.map(call => call[0].ids.length)).toEqual([1, 200, 200, 50])
  expect(flow.error.value).toContain('已完成 200 幅')
  expect(flow.canUndo.value).toBe(true)
  mocks.undo.mockResolvedValue({ restored: 199, skipped: 1 })
  await flow.undo()
  expect(mocks.undo).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operationId: 'first' }))
  expect(flow.message.value).toContain('1 幅已有新修改')
  expect(flow.canUndo.value).toBe(false)
  expect(changed).toHaveBeenCalledTimes(3)
  scope.stop()
})

it('retains the last actual undo through unchanged submissions and invalid tag retries', async () => {
  const scope = effectScope()
  const flow = scope.run(() => useGalleryOrganization({ ids: () => [1], changed: vi.fn() }))!
  const receipt = { operationId: 'changed', changes: [{ id: 1, before: {}, after: {} }] }
  mocks.organize.mockResolvedValueOnce(receipt).mockImplementation(async input => {
    normalizeArtworkOrganization(input)
    return { operationId: 'noop', changes: [] }
  })
  const input = { collectionTags: { add: ['chosen'] } }
  await flow.apply(input)
  for (const retry of [input, { collectionTags: { add: ['x'.repeat(65)] } }, input]) {
    await flow.apply(retry)
    expect(flow.canUndo.value).toBe(true)
    if (retry === input) expect(flow.message.value).toContain('已使用')
    else expect(flow.error.value).toContain('整理标签')
  }
  mocks.undo.mockResolvedValueOnce({ restored: 1, skipped: 0 })
  await flow.undo()
  expect(mocks.undo).toHaveBeenCalledExactlyOnceWith(receipt)
  expect(flow.canUndo.value).toBe(false)
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

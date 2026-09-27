import { expect, it, vi } from 'vitest'
import { createWebArtworkRepository, ARTWORK_HISTORY_KEY, ARTWORK_PROJECTS_KEY, ARTWORK_TRASH_KEY } from './artworkRepository'
import type { TrashEntry } from '../../application/artwork/artworkRepository'

function fixture() {
  const store = new Map<string, unknown>([
    [ARTWORK_HISTORY_KEY, [{ id: 'a', image_id: 'shared' }, { id: 'b', image_id: 'shared' }, { id: 'keep', image_id: 'other' }]],
    [ARTWORK_PROJECTS_KEY, [{ id: 'album', history_ids: ['a', 'b', 'keep'], future: true }]],
  ])
  const kv = {
    get: vi.fn(async (key: string) => structuredClone(store.get(key) ?? null)),
    set: vi.fn(async (key: string, value: unknown) => { store.set(key, structuredClone(value)) }),
    setMany: vi.fn(async (entries: Array<{ key: string; value: unknown }>) => {
      for (const entry of entries) store.set(entry.key, structuredClone(entry.value))
    }),
  }
  const images = { get: vi.fn(async (id: string) => ({ id, blob: new Blob(['image']), name: '', type: 'image/png', size: 5, created_at: 1 })), deleteMany: vi.fn() }
  return { store, kv, images, repository: createWebArtworkRepository({ kv, images }) }
}

it('reads each shared record once and commits one batch, retaining shared images and reversible project references', async () => {
  const { store, kv, images, repository } = fixture()
  expect(await repository.softDeleteArtworks(['a', 'b', 'missing'])).toEqual([
    { id: 'a', deleted: true }, { id: 'b', deleted: true }, { id: 'missing', deleted: false },
  ])
  expect(kv.get.mock.calls.map(([key]) => key).sort()).toEqual([ARTWORK_HISTORY_KEY, ARTWORK_PROJECTS_KEY, ARTWORK_TRASH_KEY].sort())
  expect(kv.setMany).toHaveBeenCalledOnce()
  expect(kv.set).not.toHaveBeenCalled()
  expect(images.deleteMany).not.toHaveBeenCalled()
  expect(store.get(ARTWORK_HISTORY_KEY)).toEqual([{ id: 'keep', image_id: 'other' }])
  expect(store.get(ARTWORK_PROJECTS_KEY)).toEqual([{ id: 'album', history_ids: ['keep'], future: true }])
  expect((store.get(ARTWORK_TRASH_KEY) as TrashEntry[]).map(entry => entry.historyEntries)).toEqual([
    [{ id: 'a', image_id: 'shared' }], [{ id: 'b', image_id: 'shared' }],
  ])
  await repository.restoreArtwork('a')
  await repository.restoreArtwork('b')
  expect((await repository.readHistory()).map(item => item.id).sort()).toEqual(['a', 'b', 'keep'])
  expect((store.get(ARTWORK_PROJECTS_KEY) as Array<{ history_ids: string[] }>)[0].history_ids.sort()).toEqual(['a', 'b', 'keep'])
  expect(store.get(ARTWORK_TRASH_KEY)).toEqual([])
})

it('does not publish a partial batch when the shared transaction fails', async () => {
  const { store, kv, repository } = fixture()
  const before = structuredClone(store)
  kv.setMany.mockRejectedValueOnce(new Error('quota'))
  await expect(repository.softDeleteArtworks(['a', 'b'])).rejects.toThrow('quota')
  expect(store).toEqual(before)
})

it('keeps a shared original recoverable when one tombstone from the batch expires first', async () => {
  const { store, images, repository } = fixture()
  await repository.softDeleteArtworks(['a', 'b'])
  const trash = store.get(ARTWORK_TRASH_KEY) as TrashEntry[]
  trash.find(entry => entry.id === 'a')!.deletedAt = Date.now() - 31 * 24 * 60 * 60 * 1000
  expect(await repository.purgeExpiredTrash()).toEqual({ purged: 1 })
  expect(images.deleteMany).not.toHaveBeenCalled()
  expect(await repository.restoreArtwork('b')).toEqual({ restored: true })
  expect((await repository.readHistory()).find(item => item.id === 'b')?.image_id).toBe('shared')
})

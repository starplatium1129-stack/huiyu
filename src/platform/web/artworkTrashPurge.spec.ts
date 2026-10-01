import { expect, it, vi } from 'vitest'
import { createWebArtworkRepository, ARTWORK_HISTORY_KEY, ARTWORK_TRASH_KEY } from './artworkRepository'
import { thumbKey } from '../../utils/imageThumb'
import type { TrashEntry } from '../../application/artwork/artworkRepository'

function fixture() {
  const entry = (id: string, image: string): TrashEntry => ({ id, deletedAt: 10, historyEntries: [{ id, image_id: image }], imageIds: [image], projectRefs: [] })
  const records = new Map<string, unknown>([
    [ARTWORK_HISTORY_KEY, [{ id: 'visible', image_id: 'shared' }]],
    [ARTWORK_TRASH_KEY, [entry('shared-trash', 'shared'), entry('exclusive-trash', 'exclusive')]],
    [thumbKey('exclusive'), 'exclusive-thumbnail'],
  ])
  const originals = new Map(['shared', 'exclusive'].map(id => [id, { id, blob: new Blob([id]), name: id, type: 'image/png', size: 5, created_at: 1 }]))
  const kv = {
    get: vi.fn(async (key: string) => records.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => { records.set(key, value) }),
    remove: vi.fn(async (key: string) => { records.delete(key) }),
  }
  const images = {
    get: vi.fn(async (id: string) => originals.get(id) ?? null),
    putRecord: vi.fn(async (image: { id: string; blob: Blob }) => { originals.set(image.id, { ...originals.get(image.id), ...image, name: '', type: 'image/png', size: 5, created_at: 1 }); return image.id }),
    deleteMany: vi.fn(async (ids: string[]) => { ids.forEach(id => originals.delete(id)) }),
  }
  const repository = createWebArtworkRepository({ kv, images })
  return { repository, records, originals, kv, images }
}

it('manually clears young tombstones while preserving originals used by visible artworks', async () => {
  const { repository, records, originals } = fixture()
  expect(await repository.purgeTrash(await repository.listTrash())).toEqual({ purged: 2 })
  expect(records.get(ARTWORK_TRASH_KEY)).toEqual([])
  expect(originals.has('shared')).toBe(true)
  expect(originals.has('exclusive')).toBe(false)
  expect(records.has(thumbKey('exclusive'))).toBe(false)
  expect((await repository.readHistory()).map(entry => entry.id)).toEqual(['visible'])
})

it('retains unconfirmed tombstones and re-deleted entries with a newer deletion timestamp', async () => {
  const { repository, records, originals, images } = fixture()
  const selection = [{ id: 'exclusive-trash', deletedAt: 10 }]
  ;(records.get(ARTWORK_TRASH_KEY) as TrashEntry[])[1].deletedAt = 20
  expect(await repository.purgeTrash(selection)).toEqual({ purged: 0 })
  expect(records.get(ARTWORK_TRASH_KEY)).toHaveLength(2)
  expect(originals.has('exclusive')).toBe(true)
  expect(images.deleteMany).not.toHaveBeenCalled()
})

it('compensates original and thumbnail removal if the final trash write fails, then can retry', async () => {
  const { repository, records, originals, kv } = fixture()
  kv.set.mockRejectedValueOnce(new Error('quota'))
  const selected = [{ id: 'exclusive-trash', deletedAt: 10 }]
  await expect(repository.purgeTrash(selected)).rejects.toThrow('已补偿回滚')
  expect(originals.has('exclusive')).toBe(true)
  expect(records.get(thumbKey('exclusive'))).toBe('exclusive-thumbnail')
  expect(records.get(ARTWORK_TRASH_KEY)).toHaveLength(2)
  expect(await repository.purgeTrash(selected)).toEqual({ purged: 1 })
  expect(records.get(ARTWORK_TRASH_KEY)).toHaveLength(1)
})

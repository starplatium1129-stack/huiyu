import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
const mocks = vi.hoisted(() => ({ request: vi.fn(), state: { connection: 'ready', bootstrap: { runtime: { workspace: { workspaceId: 'library-1', domains: ['artwork'] } } } } }))
vi.mock('@/api/workspace', () => ({ workspaceRequest: mocks.request }))
vi.mock('./runtime', () => ({ getDesktopRuntime: () => mocks.state, desktopRuntimeFetch: vi.fn() }))
import { createDesktopArtworkRepository } from './artworkRepository'

beforeEach(() => { mocks.request.mockResolvedValue(null) })
afterEach(() => { mocks.request.mockReset(); mocks.state.connection = 'ready'; mocks.state.bootstrap.runtime.workspace = { workspaceId: 'library-1', domains: ['artwork'] } })
it('does not write into a migration candidate or a different library after reconnecting', async () => {
  const repository = createDesktopArtworkRepository()
  mocks.state.bootstrap.runtime.workspace.domains = []
  await expect(repository.appendArtwork({ id: 1, image_id: 'a' })).rejects.toThrow('身份')
  mocks.state.bootstrap.runtime.workspace = { workspaceId: 'library-2', domains: ['artwork'] }
  await expect(repository.appendArtwork({ id: 1, image_id: 'a' })).rejects.toThrow('身份')
  expect(mocks.request).not.toHaveBeenCalled()
})
it('keeps detached loaded history while disconnected and uses the same artwork identity for retries', async () => {
  mocks.request.mockImplementation(async command => command.kind === 'listArtworks'
    ? { items: [{ id: 'original', body: { id: 'original', image_id: 'image' }, revision: 1, deletedAt: null }], nextCursor: null, revision: 1 }
    : { revision: 2 })
  const repository = createDesktopArtworkRepository()
  const history = await repository.readHistory()
  history[0].image_id = 'changed-by-view'
  mocks.state.connection = 'unavailable'
  expect((await repository.readHistory())[0].image_id).toBe('image')
  mocks.state.connection = 'ready'
  const entry = { id: 'saved', image_id: 'task-result' }
  await repository.appendArtwork(entry)
  await repository.appendArtwork(entry)
  const writes = mocks.request.mock.calls.map(([command]) => command).filter(command => command.kind === 'appendArtwork')
  expect(writes.map(command => command.operationId)).toEqual(['artwork:saved', 'artwork:saved'])
})

it('deletes a batch with one revision lookup and one mutation while retaining per-record failures', async () => {
  mocks.request.mockImplementation(async command => {
    if (command.kind === 'getArtworks') return [{ id: 1, revision: 4, deletedAt: null }, { id: 'two', revision: 7, deletedAt: null }, null]
    if (command.kind === 'softDeleteArtworks') return { softDeleteResults: [{ id: 1, deleted: true }, { id: 'two', deleted: false, code: 'REVISION_CONFLICT' }] }
    throw new Error('unexpected single-artwork request')
  })
  const repository = createDesktopArtworkRepository()
  expect(await repository.softDeleteArtworks([1, 'two', 'missing'])).toEqual([
    { id: 1, deleted: true }, { id: 'two', deleted: false }, { id: 'missing', deleted: false },
  ])
  expect(mocks.request.mock.calls.map(([command]) => command.kind)).toEqual(['getArtworks', 'softDeleteArtworks'])
  expect(mocks.request.mock.calls[1][0].items).toEqual([{ id: 1, expectedRevision: 4 }, { id: 'two', expectedRevision: 7 }])
})

it('resolves a lost batch acknowledgement from the original operation receipt', async () => {
  mocks.request.mockImplementation(async command => {
    if (command.kind === 'getArtworks') return [{ id: 'one', revision: 1, deletedAt: null }]
    if (command.kind === 'softDeleteArtworks') throw new Error('lost response')
    return { state: 'committed', receipt: { softDeleteResults: [{ id: 'one', deleted: true }] } }
  })
  expect(await createDesktopArtworkRepository().softDeleteArtworks(['one'])).toEqual([{ id: 'one', deleted: true }])
  expect(mocks.request.mock.calls[2][0]).toEqual({ kind: 'getOperation', operationId: mocks.request.mock.calls[1][0].operationId })
})

it('shares in-flight derived preview reads and reuses the completed result', async () => {
  let finish!: (value: string) => void
  mocks.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const repository = createDesktopArtworkRepository()
  const first = repository.getThumbnail('image'), second = repository.getThumbnail('image')
  await flushPromises()
  expect(mocks.request).toHaveBeenCalledOnce()
  finish('data:image/jpeg;base64,one')
  expect(await Promise.all([first, second])).toEqual(['data:image/jpeg;base64,one', 'data:image/jpeg;base64,one'])
  expect(await repository.getThumbnail('image')).toBe('data:image/jpeg;base64,one')
  expect(mocks.request).toHaveBeenCalledOnce()
})

it('evicts the least recently used entry above 96 thumbnails', async () => {
  const repository = createDesktopArtworkRepository()
  for (let index = 0; index < 96; index++) await repository.setThumbnail(`image-${index}`, `data:image/jpeg;base64,${index}`)
  await repository.getThumbnail('image-0')
  await repository.setThumbnail('image-new', 'data:image/jpeg;base64,new')
  expect(await repository.getThumbnail('image-0')).toBe('data:image/jpeg;base64,0')
  expect(await repository.getThumbnail('image-1')).toBeNull()
  expect(await repository.getThumbnail('image-95')).toBe('data:image/jpeg;base64,95')
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith({ kind: 'readThumbnail', alias: 'image-1' })
})

it('also bounds thumbnail string storage to 8 MiB, below the entry limit', async () => {
  const repository = createDesktopArtworkRepository()
  const value = 'data:image/jpeg;base64,' + 'A'.repeat(1024 * 1024 - 64)
  for (let index = 0; index < 4; index++) await repository.setThumbnail(`image-${index}`, value)
  await repository.getThumbnail('image-0')
  await repository.setThumbnail('image-new', value)
  expect(await repository.getThumbnail('image-0')).toBe(value)
  expect(await repository.getThumbnail('image-1')).toBeNull()
  expect(await repository.getThumbnail('image-new')).toBe(value)
})

it('returns an oversized generated thumbnail without retaining it in the cache', async () => {
  const value = 'data:image/jpeg;base64,' + 'A'.repeat(4 * 1024 * 1024)
  mocks.request.mockResolvedValue(value)
  const repository = createDesktopArtworkRepository()
  expect(await repository.getThumbnail('large')).toBe(value)
  expect(await repository.getThumbnail('large')).toBe(value)
  expect(mocks.request).toHaveBeenCalledTimes(2)
})

it('retries failed preview reads and preserves an explicitly published thumbnail over a late preview read', async () => {
  mocks.request.mockRejectedValueOnce(new Error('preview unavailable'))
  const repository = createDesktopArtworkRepository()
  await expect(repository.getThumbnail('image')).rejects.toThrow('preview unavailable')
  let finish!: (value: string) => void
  mocks.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const retry = repository.getThumbnail('image')
  await flushPromises()
  await repository.setThumbnail('image', 'data:image/jpeg;base64,new')
  finish('data:image/jpeg;base64,old')
  expect(await retry).toBe('data:image/jpeg;base64,new')
  expect(await repository.getThumbnail('image')).toBe('data:image/jpeg;base64,new')
})

it('forgets released media and cannot repopulate its cache from an older read', async () => {
  let finish!: (value: string) => void
  mocks.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const repository = createDesktopArtworkRepository()
  const read = repository.getThumbnail('image')
  await flushPromises()
  await repository.deleteImage('image')
  finish('data:image/jpeg;base64,released')
  await read
  mocks.request.mockResolvedValue(null)
  expect(await repository.getThumbnail('image')).toBeNull()
})

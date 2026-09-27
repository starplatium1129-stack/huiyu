import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
const mocks = vi.hoisted(() => ({ request: vi.fn(), fetch: vi.fn(), thumb: vi.fn(), state: { connection: 'ready', bootstrap: { runtime: { workspace: { workspaceId: 'library-1', domains: ['artwork'] } } } } }))
vi.mock('@/api/workspace', () => ({ workspaceRequest: mocks.request }))
vi.mock('./runtime', () => ({ getDesktopRuntime: () => mocks.state, desktopRuntimeFetch: mocks.fetch }))
vi.mock('@/utils/imageThumb', () => ({ blobThumbDataUrl: mocks.thumb }))
import { createDesktopArtworkRepository } from './artworkRepository'

beforeEach(() => {
  mocks.fetch.mockReset().mockResolvedValue({ status: 404 })
  mocks.thumb.mockReset().mockResolvedValue('data:image/jpeg;base64,cached')
})
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

function availableImage() {
  mocks.fetch.mockImplementation(async path => path === '/api/workspace/media-capabilities'
    ? { ok: true, json: async () => ({ url: '/media/image' }) }
    : { ok: true, blob: async () => new Blob(['fixture'], { type: 'image/png' }) })
}

it('shares in-flight thumbnail decoding and reuses its completed result', async () => {
  availableImage()
  let finish!: (value: string) => void
  mocks.thumb.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const repository = createDesktopArtworkRepository()
  const first = repository.getThumbnail('image'), second = repository.getThumbnail('image')
  await flushPromises()
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
  expect(mocks.thumb).toHaveBeenCalledOnce()
  finish('data:image/jpeg;base64,one')
  expect(await Promise.all([first, second])).toEqual(['data:image/jpeg;base64,one', 'data:image/jpeg;base64,one'])
  expect(await repository.getThumbnail('image')).toBe('data:image/jpeg;base64,one')
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
})

it('evicts the least recently used entry above 96 thumbnails', async () => {
  const repository = createDesktopArtworkRepository()
  for (let index = 0; index < 96; index++) await repository.setThumbnail(`image-${index}`, `data:image/jpeg;base64,${index}`)
  await repository.getThumbnail('image-0')
  await repository.setThumbnail('image-new', 'data:image/jpeg;base64,new')
  expect(await repository.getThumbnail('image-0')).toBe('data:image/jpeg;base64,0')
  expect(await repository.getThumbnail('image-1')).toBeNull()
  expect(await repository.getThumbnail('image-95')).toBe('data:image/jpeg;base64,95')
  expect(mocks.fetch).toHaveBeenCalledOnce()
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
  availableImage()
  const value = 'data:image/jpeg;base64,' + 'A'.repeat(4 * 1024 * 1024)
  mocks.thumb.mockResolvedValue(value)
  const repository = createDesktopArtworkRepository()
  expect(await repository.getThumbnail('large')).toBe(value)
  expect(await repository.getThumbnail('large')).toBe(value)
  expect(mocks.thumb).toHaveBeenCalledTimes(2)
})

it('retries failed decoding and preserves an explicitly published thumbnail over a late decode', async () => {
  availableImage()
  mocks.thumb.mockRejectedValueOnce(new Error('decoder unavailable'))
  const repository = createDesktopArtworkRepository()
  await expect(repository.getThumbnail('image')).rejects.toThrow('decoder unavailable')
  let finish!: (value: string) => void
  mocks.thumb.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const retry = repository.getThumbnail('image')
  await flushPromises()
  await repository.setThumbnail('image', 'data:image/jpeg;base64,new')
  finish('data:image/jpeg;base64,old')
  expect(await retry).toBe('data:image/jpeg;base64,new')
  expect(await repository.getThumbnail('image')).toBe('data:image/jpeg;base64,new')
})

it('forgets released media and cannot repopulate its cache from an older read', async () => {
  availableImage()
  let finish!: (value: string) => void
  mocks.thumb.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const repository = createDesktopArtworkRepository()
  const read = repository.getThumbnail('image')
  await flushPromises()
  await repository.deleteImage('image')
  finish('data:image/jpeg;base64,released')
  await read
  mocks.fetch.mockResolvedValue({ status: 404 })
  expect(await repository.getThumbnail('image')).toBeNull()
})

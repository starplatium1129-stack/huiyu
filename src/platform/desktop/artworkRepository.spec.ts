import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ request: vi.fn(), state: { connection: 'ready', bootstrap: { runtime: { workspace: { workspaceId: 'library-1', domains: ['artwork'] } } } } }))
vi.mock('@/api/workspace', () => ({ workspaceRequest: mocks.request }))
vi.mock('./runtime', () => ({ getDesktopRuntime: () => mocks.state, desktopRuntimeFetch: vi.fn() }))
import { createDesktopArtworkRepository } from './artworkRepository'

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

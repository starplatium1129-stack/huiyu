import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
const mocks = vi.hoisted(() => ({ request: vi.fn(), state: { connection: 'ready', bootstrap: { runtime: { origin: 'http://localhost:1', runtimeEpoch: 'epoch-1', workspace: { workspaceId: 'library-1', runtimeEpoch: 'epoch-1', generation: 1, domains: ['artwork'] } } } } }))
vi.mock('@/api/workspace', () => ({ workspaceRequest: mocks.request }))
vi.mock('./runtime', () => ({ getDesktopRuntime: () => mocks.state, desktopRuntimeFetch: vi.fn() }))
import { createDesktopArtworkRepository } from './artworkRepository'

beforeEach(() => { mocks.request.mockResolvedValue(null) })
afterEach(() => { mocks.request.mockReset(); mocks.state.connection = 'ready'; mocks.state.bootstrap.runtime.workspace = { workspaceId: 'library-1', runtimeEpoch: 'epoch-1', generation: 1, domains: ['artwork'] } })

it('revalidates unchanged history without rereading bodies and reloads a changed authority revision', async () => {
  let revision = 1, title = 'original'
  mocks.request.mockImplementation(async command => {
    if (command.kind === 'status') return { revision: 900 + revision, artworkRevision: revision, writerEpoch: 'epoch-1' }
    if (command.kind === 'listArtworks') return { items: [{ id: 'a', body: { id: 'a', title }, revision, deletedAt: null }], revision, artworkRevision: revision, nextCursor: null }
    throw new Error('unexpected request')
  })
  const repository = createDesktopArtworkRepository()
  const first = await repository.readHistory()
  first[0]!.title = 'caller edit'
  expect(await repository.readHistory()).toEqual([{ id: 'a', title: 'original' }])
  expect(mocks.request.mock.calls.map(([command]) => command.kind)).toEqual(['listArtworks', 'status'])
  revision = 2; title = 'other window edit'
  expect(await repository.readHistory()).toEqual([{ id: 'a', title }])
  expect(mocks.request.mock.calls.map(([command]) => command.kind)).toEqual(['listArtworks', 'status', 'status', 'listArtworks'])
  mocks.request.mockRejectedValueOnce(new Error('authority unavailable'))
  await expect(repository.readHistory()).rejects.toThrow('authority unavailable')
  mocks.request.mockResolvedValueOnce({ revision: 900 + revision, artworkRevision: revision, writerEpoch: 'different-writer' })
  await expect(repository.readHistory()).rejects.toThrow('连接已变化')
})

it('does not reuse a history snapshot after cancellation or a write during its status check', async () => {
  let favorite = false, revision = 1, acknowledge!: (value: unknown) => void
  const row = () => ({ id: 'a', body: { id: 'a', favorite }, revision, deletedAt: null })
  mocks.request.mockImplementation(async command => {
    if (command.kind === 'listArtworks') return { items: [row()], revision, artworkRevision: revision, nextCursor: null }
    if (command.kind === 'status') return new Promise(resolve => { acknowledge = resolve })
    if (command.kind === 'getArtwork') return row()
    if (command.kind === 'patchArtwork') { favorite = true; revision++; return { changed: true } }
    throw new Error('unexpected request')
  })
  const repository = createDesktopArtworkRepository()
  await repository.readHistory()
  const controller = new AbortController(), cancelled = repository.readHistory(controller.signal)
  controller.abort(); acknowledge({ revision: 1, artworkRevision: 1, writerEpoch: 'epoch-1' })
  await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  const pending = repository.readHistory()
  await repository.patchArtwork('a', { favorite: true })
  acknowledge({ revision: 1, artworkRevision: 1, writerEpoch: 'epoch-1' })
  expect(await pending).toEqual([{ id: 'a', favorite: true }])
})

it('does not replace a newer cached revision with an older read that finishes later', async () => {
  const pending: Array<(value: unknown) => void> = []
  mocks.request.mockImplementation(() => new Promise(resolve => { pending.push(resolve) }))
  const repository = createDesktopArtworkRepository()
  const older = repository.readHistory(), newer = repository.readHistory()
  const page = (revision: number) => ({ items: [{ id: 'a', body: { id: 'a', title: String(revision) }, revision, deletedAt: null }], revision, artworkRevision: revision, nextCursor: null })
  pending[1]!(page(2)); await newer
  pending[0]!(page(1)); await older
  mocks.state.connection = 'unavailable'
  expect(await repository.readHistory()).toEqual([{ id: 'a', title: '2' }])
})

it.each(['workspace', 'domain', 'generation'])('keeps same-authority offline snapshots but rejects a changed %s', async change => {
  const body = { id: 'a', timestamp: 1, scene: 'scene-a' }
  const row = { id: 'a', body, revision: 1, deletedAt: null }
  mocks.request.mockImplementation(async command => {
    if (command.kind === 'listArtworks') return { items: [row], revision: 1, artworkRevision: 1, nextCursor: null }
    if (command.kind === 'listProjects') return { items: [{ body: { id: 'album-a', title: 'A', history_ids: ['a'] } }] }
    if (command.kind === 'readArtworkRecentIndex') return { items: [{ id: 'a', timestamp: 1, revision: 1 }], revision: 1 }
    if (command.kind === 'getArtworks') return [row]
    throw new Error('unexpected request')
  })
  const repository = createDesktopArtworkRepository()
  const reads = [() => repository.readHistory(), () => repository.readProjects(),
    () => repository.readPreferenceHistory(), () => repository.readRecentHistory()]
  for (const read of reads) expect(await read()).toHaveLength(1)
  mocks.state.connection = 'unavailable'
  const requests = mocks.request.mock.calls.length
  for (const read of reads) expect(await read()).toHaveLength(1)
  if (change === 'workspace') mocks.state.bootstrap.runtime.workspace.workspaceId = 'library-b'
  else if (change === 'domain') mocks.state.bootstrap.runtime.workspace.domains = []
  else mocks.state.bootstrap.runtime.workspace.generation++
  for (const read of reads) await expect(read()).rejects.toThrow()
  expect(mocks.request).toHaveBeenCalledTimes(requests)
})

it('does not publish an old-session project response over the new offline snapshot', async () => {
  let finish!: (value: { items: Array<{ body: { id: string; history_ids: string[] } }> }) => void
  mocks.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValueOnce({ items: [{ body: { id: 'new-album', history_ids: [] } }] })
  const repository = createDesktopArtworkRepository()
  const old = repository.readProjects()
  mocks.state.bootstrap.runtime.workspace.generation++
  expect(await repository.readProjects()).toEqual([{ id: 'new-album', history_ids: [] }])
  finish({ items: [{ body: { id: 'old-album', history_ids: [] } }] })
  await expect(old).rejects.toThrow('读取期间发生变更')
  mocks.state.connection = 'unavailable'
  expect(await repository.readProjects()).toEqual([{ id: 'new-album', history_ids: [] }])
  expect(mocks.request).toHaveBeenCalledTimes(2)
})

it.each(['history', 'projects', 'preferences', 'recent'])('keeps a pre-write %s response consumable without republishing it as an offline cache', async kind => {
  const item = { id: 'saved', body: { id: 'saved', favorite: false }, revision: 1, deletedAt: null }
  const old = kind === 'projects' ? { items: [{ body: { id: 'new-album', history_ids: ['saved'] } }] }
    : kind === 'recent' ? [item] : { items: [item], nextCursor: null, revision: 1, artworkRevision: 1 }
  let finish!: (value: unknown) => void
  mocks.request.mockImplementation(async command => {
    if (command.kind === 'getArtwork') return item
    if (command.kind === 'patchArtwork') return { changed: true }
    if (command.kind === 'readArtworkRecentIndex') return { items: [{ id: 'saved', revision: 1, timestamp: 1 }], revision: 1 }
    return new Promise(resolve => { finish = resolve })
  })
  const repository = createDesktopArtworkRepository()
  const read = () => kind === 'history' ? repository.readHistory() : kind === 'projects' ? repository.readProjects()
    : kind === 'preferences' ? repository.readPreferenceHistory() : repository.readRecentHistory()
  const pending = read()
  await flushPromises()
  await repository.patchArtwork('saved', { favorite: true })
  finish(old)
  expect(await pending).toHaveLength(1) // The gallery can still consume and overlay unrelated incoming records.
  mocks.state.connection = 'unavailable'
  mocks.request.mockRejectedValue(new Error('offline'))
  await expect(read()).rejects.toThrow('offline') // No confirmed post-write snapshot exists yet.
  mocks.state.connection = 'ready'
  const updated = { ...item, body: { ...item.body, favorite: true } }
  mocks.request.mockImplementation(async command => command.kind === 'listProjects' ? old
    : command.kind === 'readArtworkRecentIndex' ? { items: [{ id: 'saved', revision: 1, timestamp: 1 }], revision: 1 }
      : command.kind === 'getArtworks' ? [updated] : { items: [updated], nextCursor: null, revision: 2, artworkRevision: 2 })
  const fresh = await read(), calls = mocks.request.mock.calls.length
  mocks.state.connection = 'unavailable'
  expect(await read()).toEqual(fresh)
  expect(mocks.request).toHaveBeenCalledTimes(calls)
})

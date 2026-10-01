import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import type { ArtworkRecord } from '../../types/artwork'
const mocks = vi.hoisted(() => ({ request: vi.fn(), state: { connection: 'ready', bootstrap: { runtime: { workspace: { workspaceId: 'library-1', domains: ['artwork'] } } } } }))
vi.mock('@/api/workspace', () => ({ workspaceRequest: mocks.request }))
vi.mock('./runtime', () => ({ getDesktopRuntime: () => mocks.state, desktopRuntimeFetch: vi.fn() }))
import { createDesktopArtworkRepository } from './artworkRepository'

beforeEach(() => { mocks.request.mockResolvedValue(null) })
it('creates a project through the workspace and reconciles a lost response using its stable operation identity', async () => {
  const body = { id: 'album-new', title: '秋日手记', history_ids: [] }
  mocks.request.mockImplementation(async command => {
    if (command.kind === 'listProjects') return { items: [] }
    if (command.kind === 'saveProject') throw new Error('lost response')
    if (command.kind === 'getOperation') return { state: 'committed', receipt: { project: { body } } }
    throw new Error('unexpected command')
  })
  const repository = createDesktopArtworkRepository()
  await repository.readProjects()
  const saved = await repository.createProject({ id: 'album-new', title: ' 秋日手记 ' })
  expect(saved).toEqual(body)
  expect(mocks.request).toHaveBeenCalledWith({ kind: 'saveProject', operationId: 'create-project:album-new',
    project: body, artworkIds: [], expectedRevision: null }, undefined)
  expect(mocks.request).toHaveBeenCalledWith({ kind: 'getOperation', operationId: 'create-project:album-new' }, undefined)
  mocks.state.connection = 'unavailable'
  mocks.request.mockResolvedValueOnce({ items: [{ body }] })
  expect(await repository.readProjects()).toEqual([body])
  saved.title = 'consumer edit'
  expect(body.title).toBe('秋日手记')
})
afterEach(() => { mocks.request.mockReset(); mocks.state.connection = 'ready'; mocks.state.bootstrap.runtime.workspace = { workspaceId: 'library-1', domains: ['artwork'] } })
it('purges bounded confirmed tombstone batches and reconciles a lost committed response', async () => {
  const entries = Array.from({ length: 205 }, (_, index) => ({ id: String(index), deletedAt: 10 }))
  let calls = 0
  mocks.request.mockImplementation(async command => {
    if (command.kind === 'getOperation') return { state: 'committed', receipt: { purged: 200 } }
    if (++calls === 1) throw new Error('response lost after commit')
    return { purged: command.entries.length }
  })
  const repository = createDesktopArtworkRepository(), pending = repository.purgeTrash(entries)
  entries[0].deletedAt = 999
  expect(await pending).toEqual({ purged: 205 })
  const batches = mocks.request.mock.calls.map(([command]) => command).filter(command => command.kind === 'purgeTrash')
  expect(batches.map(command => command.entries.length)).toEqual([200, 5])
  expect(batches[0].entries[0]).toEqual({ id: '0', deletedAt: 10 })
  expect(mocks.request.mock.calls[1][0].operationId).toBe(batches[0].operationId)
})
it('does not write into a migration candidate or a different library after reconnecting', async () => {
  const repository = createDesktopArtworkRepository()
  mocks.state.bootstrap.runtime.workspace.domains = []
  await expect(repository.appendArtwork({ id: 1, image_id: 'a' })).rejects.toThrow('身份')
  mocks.state.bootstrap.runtime.workspace = { workspaceId: 'library-2', domains: ['artwork'] }
  await expect(repository.appendArtwork({ id: 1, image_id: 'a' })).rejects.toThrow('身份')
  expect(mocks.request).not.toHaveBeenCalled()
})
it('reads only three recent bodies after one atomic summary while preserving timestamp fallback and stable ties', async () => {
  const bodies: ArtworkRecord[] = [{ id: 10, timestamp: 100 }, { id: 20, timestamp: 100 }, { id: 999, timestamp: 'invalid' }, { id: 1, timestamp: 50 }]
  const row = (body: ArtworkRecord) => ({ id: body.id, body, revision: 3, deletedAt: null })
  mocks.request.mockImplementation(async command => command.kind === 'readArtworkRecentIndex'
    ? { items: bodies.map(body => ({ id: body.id, timestamp: body.timestamp, revision: 3 })), revision: 7 }
    : command.ids.map((id: number) => row({ ...bodies.find(body => body.id === id)!, sceneTitle: 'Full body', prompt: 'neutral complete prompt' })))
  const repository = createDesktopArtworkRepository(), controller = new AbortController()
  const history = await repository.readRecentHistory(controller.signal)
  expect(history.map(item => item.id)).toEqual([999, 10, 20])
  expect(history[0]).toMatchObject({ sceneTitle: 'Full body', prompt: 'neutral complete prompt' })
  expect(mocks.request.mock.calls.map(([command]) => command.kind)).toEqual(['readArtworkRecentIndex', 'getArtworks'])
  expect(mocks.request.mock.calls.every(([, signal]) => signal === controller.signal)).toBe(true)
  mocks.state.connection = 'unavailable'; history[0].prompt = 'consumer edit'
  expect((await repository.readRecentHistory())[0].prompt).toBe('neutral complete prompt')
})
it('keeps the last complete recent snapshot when a body lookup fails or its revision changes', async () => {
  const selected = { id: 'recent', body: { id: 'recent', timestamp: 100 }, revision: 3, deletedAt: null }
  mocks.request.mockResolvedValueOnce({ items: [selected], nextCursor: null, revision: 7 }).mockResolvedValueOnce([selected])
  const repository = createDesktopArtworkRepository(); await repository.readRecentHistory()
  mocks.request.mockResolvedValueOnce({ items: [selected], nextCursor: null, revision: 7 }).mockRejectedValueOnce(new Error('body read failed'))
  await expect(repository.readRecentHistory()).rejects.toThrow('body read failed')
  mocks.request.mockResolvedValueOnce({ items: [selected], nextCursor: null, revision: 7 }).mockResolvedValueOnce([{ ...selected, revision: 4 }])
  await expect(repository.readRecentHistory()).rejects.toThrow('发生变更')
  mocks.state.connection = 'unavailable'
  expect((await repository.readRecentHistory()).map(item => item.id)).toEqual(['recent'])
})
it('uses the latest completed snapshot when recent and full-library reads alternate before disconnecting', async () => {
  const row = (id: string) => ({ id, body: { id }, revision: 1, deletedAt: null })
  const page = (id: string) => ({ items: [row(id)], nextCursor: null, revision: 1 })
  const repository = createDesktopArtworkRepository()
  mocks.request.mockResolvedValueOnce(page('older-full')); await repository.readHistory()
  mocks.request.mockResolvedValueOnce(page('newer-recent')).mockResolvedValueOnce([row('newer-recent')]); await repository.readRecentHistory()
  mocks.state.connection = 'unavailable'
  expect((await repository.readRecentHistory())[0].id).toBe('newer-recent')
  mocks.state.connection = 'ready'
  mocks.request.mockResolvedValueOnce(page('latest-full')); await repository.readHistory()
  mocks.state.connection = 'unavailable'
  expect((await repository.readRecentHistory())[0].id).toBe('latest-full')
})
it('cancels recent-work pages and late body lookups without replacing the cached snapshot', async () => {
  const selected = { id: 'saved', body: { id: 'saved' }, revision: 1, deletedAt: null }
  const page = { items: [selected], nextCursor: null, revision: 1 }
  const repository = createDesktopArtworkRepository()
  mocks.request.mockResolvedValueOnce(page).mockResolvedValueOnce([selected]); await repository.readRecentHistory()
  let finish!: (value: unknown) => void
  mocks.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const firstController = new AbortController(), first = repository.readRecentHistory(firstController.signal)
  firstController.abort(); finish({ ...page, nextCursor: 'next' })
  await expect(first).rejects.toMatchObject({ name: 'AbortError' })
  expect(mocks.request).toHaveBeenCalledTimes(3)
  mocks.request.mockResolvedValueOnce(page).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const secondController = new AbortController(), second = repository.readRecentHistory(secondController.signal)
  await flushPromises(); secondController.abort(); finish([{ ...selected, body: { id: 'late' } }])
  await expect(second).rejects.toMatchObject({ name: 'AbortError' })
  mocks.state.connection = 'unavailable'
  expect((await repository.readRecentHistory()).map(item => item.id)).toEqual(['saved'])
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
  expect(mocks.request.mock.calls.filter(([command]) => command.kind === 'listArtworks')).toHaveLength(1)
})

it('reads one detached record by identity, filters deleted records and rejects malformed or mismatched rows', async () => {
  const row = { id: 42, body: { id: 42, nested: { keep: true } }, revision: 1, deletedAt: null }
  const repository = createDesktopArtworkRepository()
  mocks.request.mockResolvedValue(row)
  const item = await repository.readArtwork('42')
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith({ kind: 'getArtwork', id: '42' }, undefined)
  ;(item!.nested as { keep: boolean }).keep = false
  expect((await repository.readArtwork(42))?.nested).toEqual({ keep: true })
  mocks.request.mockResolvedValue({ ...row, deletedAt: 5 })
  expect(await repository.readArtwork(42)).toBeNull()
  mocks.request.mockResolvedValue(null)
  expect(await repository.readArtwork('missing')).toBeNull()
  for (const invalid of [{ ...row, id: 'other' }, { ...row, body: { id: 'wrong' } }, { ...row, revision: -1 }, { ...row, deletedAt: undefined }]) {
    mocks.request.mockResolvedValue(invalid)
    await expect(repository.readArtwork(42)).rejects.toThrow('响应无效')
  }
})

it('rejects incomplete, duplicate or invalid recent indexes before body reads', async () => {
  const repository = createDesktopArtworkRepository()
  const item = { id: 'one', timestamp: 'Fri, 01 Jan 2021 00:00:00 GMT', revision: 1 }
  for (const invalid of [null, { items: [item] }, { items: null, revision: 2 },
    { items: [item, { ...item, id: ' one ' }], revision: 2 }, { items: [item, {}], revision: 2 },
    { items: [{ ...item, revision: 3 }], revision: 2 }, { items: [{ ...item, revision: 0.5 }], revision: 2 }]) {
    mocks.request.mockResolvedValue(invalid)
    await expect(repository.readRecentHistory()).rejects.toThrow('索引无效')
  }
  expect(mocks.request.mock.calls.every(([command]) => command.kind === 'readArtworkRecentIndex')).toBe(true)
})

it('organizes a bounded selection with one revision lookup and recovers its stable receipt after a lost acknowledgement', async () => {
  const receipt = { operationId: '', changes: [{ id: 'one', before: { project: { present: false } }, after: { project: { present: true, value: 'album' } } }] }
  mocks.request.mockImplementation(async command => {
    if (command.kind === 'getArtworks') return [{ id: 'one', body: { id: 'one' }, revision: 4, deletedAt: null }]
    if (command.kind === 'organizeArtworks') { receipt.operationId = command.operationId; throw new Error('lost acknowledgement') }
    if (command.kind === 'getOperation') return { state: 'committed', receipt }
    if (command.kind === 'undoArtworkOrganization') return { restored: 1, skipped: 0 }
    throw new Error('unexpected full-library read')
  })
  const repository = createDesktopArtworkRepository()
  const result = await repository.organizeArtworks({ ids: ['one'], projectId: 'album' })
  expect(mocks.request.mock.calls.map(([command]) => command.kind)).toEqual(['getArtworks', 'organizeArtworks', 'getOperation'])
  expect(mocks.request.mock.calls[1][0]).toMatchObject({ expectedRevisions: [{ id: 'one', revision: 4 }], projectId: 'album' })
  expect(mocks.request.mock.calls[2][0].operationId).toBe(mocks.request.mock.calls[1][0].operationId)
  expect(await repository.undoArtworkOrganization({ ...result, changes: [] })).toEqual({ restored: 1, skipped: 0 })
  const undo = mocks.request.mock.calls[3][0]
  expect(undo.sourceOperationId).toBe(receipt.operationId)
  expect(undo).not.toHaveProperty('changes')
})

it('cancels paginated reads without starting another page or replacing the last complete history', async () => {
  const page = (id: string, nextCursor: string | null) => ({ items: [{ id, body: { id }, revision: 1, deletedAt: null }], nextCursor, revision: 1 })
  mocks.request.mockResolvedValueOnce(page('saved', null))
  const repository = createDesktopArtworkRepository()
  await repository.readHistory()
  mocks.request.mockClear()
  let finish!: (value: ReturnType<typeof page>) => void
  mocks.request.mockResolvedValueOnce(page('partial', 'next'))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const controller = new AbortController()
  const reading = repository.readHistory(controller.signal)
  await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2))
  expect(mocks.request.mock.calls.every(([, signal]) => signal === controller.signal)).toBe(true)
  controller.abort()
  finish(page('late', 'third'))
  await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
  expect(mocks.request).toHaveBeenCalledTimes(2)
  mocks.state.connection = 'unavailable'
  expect((await repository.readHistory()).map(item => item.id)).toEqual(['saved'])
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
  expect(mocks.request).toHaveBeenCalledOnce()
  expect(mocks.request.mock.calls[0][0]).toEqual({ kind: 'readThumbnail', alias: 'image-1' })
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
it('reads paged recommendation fields without loading the full library cache', async () => {
  mocks.request.mockImplementation(async command => ({items:[{id:command.cursor?'b':'a',body:{id:command.cursor?'b':'a',scene:'sc001',favorite:true},revision:3,deletedAt:null}],nextCursor:command.cursor?null:'next',revision:3}))
  const repository=createDesktopArtworkRepository();const rows=await repository.readPreferenceHistory()
  expect(rows).toHaveLength(2)
  expect(mocks.request.mock.calls.map(([c])=>c.projection)).toEqual(['preference','preference'])
  expect(mocks.request.mock.calls[1][0].cursor).toBe('next')
  mocks.state.connection='unavailable';(rows[0] as {scene:string}).scene='changed'
  expect((await repository.readPreferenceHistory())[0]).toMatchObject({scene:'sc001'})
})

it('reads a complete search index once, detaches offline data and invalidates it after edits', async () => {
  const record = { id: 'old', title: 'Original', timestamp: 'January 1, 2020', searchText: 'original moonlight' }
  mocks.request.mockResolvedValue({ items: [record], revision: 9 })
  const repository = createDesktopArtworkRepository()
  const controller = new AbortController()
  const index = await repository.readSearchIndex(controller.signal)
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith({ kind: 'readArtworkSearchIndex' }, controller.signal)
  index[0].title = 'changed by consumer'
  mocks.state.connection = 'unavailable'
  expect((await repository.readSearchIndex())[0]).toMatchObject({ title: 'Original' })
  expect(mocks.request).toHaveBeenCalledOnce()
  controller.abort()
  await expect(repository.readSearchIndex(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  mocks.state.connection = 'ready'
  mocks.request.mockImplementation(async command => command.kind === 'getArtwork'
    ? { id: 'old', body: { id: 'old' }, revision: 9, deletedAt: null } : { changed: true })
  await repository.patchArtwork('old', { title: 'edited' })
  mocks.state.connection = 'unavailable'
  mocks.request.mockRejectedValue(new Error('offline'))
  await expect(repository.readSearchIndex()).rejects.toThrow('offline')
  mocks.state.bootstrap.runtime.workspace.workspaceId = 'another-library'
  await expect(repository.readSearchIndex()).rejects.toThrow('身份')
})

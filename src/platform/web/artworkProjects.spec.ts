import { describe, expect, it, vi } from 'vitest'
import { createWebArtworkRepository, ARTWORK_HISTORY_KEY, ARTWORK_PROJECTS_KEY } from './artworkRepository'

function fixture() {
  const data = new Map<string, unknown>([
    [ARTWORK_HISTORY_KEY, [{ id: 1, prompt: 'original generation', image_id: 'original' }]],
    [ARTWORK_PROJECTS_KEY, [{ id: 'old', title: '已有画册', history_ids: [], custom: 'preserved' }]],
  ])
  const kv = {
    get: vi.fn(async (key: string) => structuredClone(data.get(key))),
    set: vi.fn(async (key: string, value: unknown) => { data.set(key, structuredClone(value)) }),
    setMany: vi.fn(async (entries: Array<{ key: string; value: unknown }>) => {
      entries.forEach(entry => data.set(entry.key, structuredClone(entry.value)))
    }),
  }
  return { data, kv, repository: createWebArtworkRepository({ kv }) }
}

describe('creating a gallery album', () => {
  it('creates, organizes existing artwork and retries the same identity without losing members', async () => {
    const f = fixture(), input = { id: 'album-new', title: '  秋日手记  ' }
    const pending = f.repository.createProject(input)
    input.title = 'consumer edit'
    const album = await pending
    expect(album).toEqual({ id: 'album-new', title: '秋日手记', history_ids: [] })
    const receipt = await f.repository.organizeArtworks({ ids: [1], projectId: album.id })
    expect(await f.repository.createProject({ id: 'album-new', title: '秋日手记' })).toMatchObject({ history_ids: [1] })
    expect(f.kv.set).toHaveBeenCalledTimes(1)
    const history = await f.repository.readHistory()
    expect(history[0]).toMatchObject({ id: 1, prompt: 'original generation', image_id: 'original', project: 'album-new' })
    ;(album.history_ids as unknown[]).push('consumer edit')
    expect((await f.repository.readProjects())[0]).toMatchObject({ custom: 'preserved' })
    expect((await f.repository.readProjects())[1].history_ids).toEqual([1])
    expect(await f.repository.undoArtworkOrganization(receipt)).toEqual({ restored: 1, skipped: 0 })
    expect((await f.repository.readProjects())[1].history_ids).toEqual([])
  })

  it('reconciles a committed creation whose acknowledgement was lost', async () => {
    const f = fixture()
    f.kv.set.mockImplementationOnce(async (key, value) => { f.data.set(key, value); throw new Error('reply lost') })
    await expect(f.repository.createProject({ id: 'album-new', title: '新画册' })).resolves.toMatchObject({ id: 'album-new' })
    expect(await f.repository.readProjects()).toHaveLength(2)
  })

  it('rejects invalid names and conflicting identities without changing the library', async () => {
    const f = fixture(), before = structuredClone([...f.data])
    await expect(f.repository.createProject({ id: 'album-new', title: '  ' })).rejects.toThrow('画册名称')
    await expect(f.repository.createProject({ id: 'old', title: 'different' })).rejects.toThrow('编号已被使用')
    f.kv.set.mockRejectedValueOnce(new Error('quota'))
    await expect(f.repository.createProject({ id: 'album-new', title: '新画册' })).rejects.toThrow('quota')
    expect([...f.data]).toEqual(before)
  })
})

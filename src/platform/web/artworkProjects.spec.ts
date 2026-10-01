import { describe, expect, it, vi } from 'vitest'
import { createWebArtworkRepository, ARTWORK_HISTORY_KEY, ARTWORK_PROJECTS_KEY } from './artworkRepository'
import { normalizeSmartAlbumRule, parseSmartAlbumRule, type SmartAlbumRule } from '../../application/artwork/smartAlbums'

const smartRule = (): SmartAlbumRule => ({ characterId: 'custom-role', tags: ['和服'], tagMatch: 'all', favoriteOnly: true, search: '', projectId: '' })

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

  it('round-trips and edits detached smart rules, preserving manual records, history and project fields', async () => {
    const f = fixture(), history = structuredClone(f.data.get(ARTWORK_HISTORY_KEY)), manual = structuredClone((f.data.get(ARTWORK_PROJECTS_KEY) as unknown[])[0])
    const input = { id: 'smart-new', title: '  和服收藏  ', rule: { ...smartRule(), characterId: ' custom-role ', tags: [' 和服 ', '和服'], projectId: 'old' } }
    const pending = f.repository.saveSmartAlbum(input)
    input.rule.tags.push('consumer edit'); input.rule.search = 'consumer edit'
    const saved = await pending
    expect(saved).toEqual({ id: 'smart-new', title: '和服收藏', history_ids: [], smartRule: { ...smartRule(), projectId: 'old' } })
    const projects = f.data.get(ARTWORK_PROJECTS_KEY) as Array<Record<string, unknown>>
    projects[1].custom = { preserved: true }
    await f.repository.saveSmartAlbum({ id: 'smart-new', title: '精选', rule: { ...smartRule(), tags: ['海边'], tagMatch: 'any', favoriteOnly: false } })
    expect((await f.repository.readProjects())[1]).toMatchObject({ custom: { preserved: true }, smartRule: { tags: ['海边'], tagMatch: 'any', favoriteOnly: false } })
    ;(saved.smartRule as SmartAlbumRule).tags.push('detached')
    await f.repository.saveSmartAlbum({ id: 'smart-new', title: '精选', rule: { ...smartRule(), tags: ['海边'], tagMatch: 'any', favoriteOnly: false } })
    expect(f.kv.set).toHaveBeenCalledTimes(2)
    expect(await f.repository.deleteSmartAlbum('smart-new')).toEqual({ deleted: true })
    expect(await f.repository.deleteSmartAlbum('smart-new')).toEqual({ deleted: false })
    expect(f.data.get(ARTWORK_HISTORY_KEY)).toEqual(history)
    expect(f.data.get(ARTWORK_PROJECTS_KEY)).toEqual([manual])
    expect(f.kv.set.mock.calls.every(([key]) => key === ARTWORK_PROJECTS_KEY)).toBe(true)
  })

  it('reconciles lost write/delete acknowledgements and keeps failed writes out of the library', async () => {
    const f = fixture(), input = { id: 'smart-new', title: '精选', rule: smartRule() }
    f.kv.set.mockImplementationOnce(async (key, value) => { f.data.set(key, structuredClone(value)); throw new Error('reply lost') })
    await expect(f.repository.saveSmartAlbum(input)).resolves.toMatchObject({ id: input.id })
    f.kv.set.mockRejectedValueOnce(new Error('quota'))
    await expect(f.repository.saveSmartAlbum({ ...input, title: 'changed' })).rejects.toThrow('quota')
    expect((await f.repository.readProjects())[1].title).toBe('精选')
    f.kv.set.mockImplementationOnce(async (key, value) => { f.data.set(key, structuredClone(value)); throw new Error('reply lost') })
    await expect(f.repository.deleteSmartAlbum(input.id)).resolves.toEqual({ deleted: true })
  })

  it('rejects malformed rules, manual replacement and recursive smart conditions without any write', async () => {
    const f = fixture(), before = structuredClone([...f.data])
    for (const input of [null, {}, { ...smartRule(), tags: [''] }, { ...smartRule(), favoriteOnly: 'yes' }, { ...smartRule(), tagMatch: 'none' }]) {
      expect(parseSmartAlbumRule(input)).toBeNull()
      expect(() => normalizeSmartAlbumRule(input)).toThrow('智能画册')
    }
    await expect(f.repository.saveSmartAlbum({ id: 'old', title: 'changed', rule: smartRule() })).rejects.toThrow('手动画册')
    await expect(f.repository.deleteSmartAlbum('old')).rejects.toThrow('智能画册')
    await expect(f.repository.saveSmartAlbum({ id: 'smart-new', title: '新', rule: { ...smartRule(), projectId: 'missing' } })).rejects.toThrow('手动画册')
    expect([...f.data]).toEqual(before)
    await f.repository.saveSmartAlbum({ id: 'smart-new', title: '新', rule: smartRule() })
    await expect(f.repository.saveSmartAlbum({ id: 'smart-two', title: '新', rule: { ...smartRule(), projectId: 'smart-new' } })).rejects.toThrow('手动画册')
    await expect(f.repository.saveSmartAlbum({ id: 'smart-new', title: '新', rule: { ...smartRule(), projectId: 'smart-new' } })).rejects.toThrow('手动画册')
    await expect(f.repository.createProject({ id: 'smart-new', title: '新' })).rejects.toThrow('编号已被使用')
    const projects = f.data.get(ARTWORK_PROJECTS_KEY) as Array<Record<string, unknown>>
    projects.push({ id: 'smart-new', title: 'duplicate manual', history_ids: [1] })
    const duplicateSnapshot = structuredClone([...f.data])
    await expect(f.repository.deleteSmartAlbum('smart-new')).rejects.toThrow('编号存在冲突')
    await expect(f.repository.saveSmartAlbum({ id: 'smart-new', title: '新', rule: smartRule() })).rejects.toThrow('编号存在冲突')
    expect([...f.data]).toEqual(duplicateSnapshot)
  })
})

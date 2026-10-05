import { describe, expect, it, vi } from 'vitest'
import { createArtworkOrganization } from './artworkOrganization'
import { ARTWORK_HISTORY_KEY, ARTWORK_PROJECTS_KEY } from './artworkStorage'
import { ARTWORK_ORGANIZATION_RECEIPT_LIMIT } from '../../application/artwork/organization'

function fixture() {
  const data = new Map<string, unknown>([
    [ARTWORK_HISTORY_KEY, [{ id: 1, project: 'old', manual_tags: ['generated'], prompt: 'original', collectionTags: ['draft'] },
      { id: 'two', project: 'old', manual_tags: ['second'] }]],
    [ARTWORK_PROJECTS_KEY, [{ id: 'old', history_ids: [1, 'two'], untouched: 'album' }, { id: 7, history_ids: [] }]],
  ])
  const commit = vi.fn(async (entries: Array<{ key: string; value: unknown }>) => {
    entries.forEach(entry => data.set(entry.key, structuredClone(entry.value)))
  })
  const organization = createArtworkOrganization({ kv: { get: async key => structuredClone(data.get(key)), set: async () => {} },
    commit, enqueue: async work => work() })
  const history = () => data.get(ARTWORK_HISTORY_KEY) as Array<Record<string, unknown>>
  const projects = () => data.get(ARTWORK_PROJECTS_KEY) as Array<Record<string, unknown>>
  return { data, commit, organization, history, projects }
}

describe('artwork organization transaction', () => {
  it('does not manually assign artwork into valid or malformed smart albums', async () => {
    const f = fixture(), before = structuredClone(f.history())
    for (const smartRule of [null, { tags: ['和服'] }]) {
      f.projects()[1].smartRule = smartRule
      await expect(f.organization.organizeArtworks({ ids: [1], projectId: 7 })).rejects.toThrow('智能画册按条件收录')
      expect(f.history()).toEqual(before)
      expect(f.projects()[1].history_ids).toEqual([])
    }
    expect(f.commit).not.toHaveBeenCalled()
  })
  it('moves both membership directions, retains IDs and generated facts, and undoes only its own fields', async () => {
    const f = fixture()
    const receipt = await f.organization.organizeArtworks({ ids: [1, 'two'], projectId: 7, collectionTags: { add: [' chosen ', 'chosen'], remove: ['draft'] } })
    expect(receipt.changes).toHaveLength(2)
    expect(f.projects().map(project => project.history_ids)).toEqual([[], [1, 'two']])
    expect(f.history()[0]).toMatchObject({ id: 1, project: '7', manual_tags: ['generated'], prompt: 'original', collectionTags: ['chosen'] })
    expect(f.projects()[1].id).toBe(7)
    f.history()[0].favorite = true
    f.projects()[0].title = 'new title'
    // A caller cannot smuggle prompt changes into the receipt.
    receipt.changes[0].before.collectionTags!.value = ['tampered']
    expect(await f.organization.undoArtworkOrganization(receipt)).toEqual({ restored: 2, skipped: 0 })
    expect(f.projects().map(project => project.history_ids)).toEqual([[1, 'two'], []])
    expect(f.history()[0]).toMatchObject({ favorite: true, project: 'old', collectionTags: ['draft'], prompt: 'original' })
    expect(f.history()[1]).not.toHaveProperty('collectionTags')
    expect(f.projects()[0].title).toBe('new title')
  })

  it('skips artworks changed by another window and preserves unrelated new album members', async () => {
    const f = fixture()
    const receipt = await f.organization.organizeArtworks({ ids: [1, 'two'], projectId: 7 })
    f.history()[0].project = 'later'
    f.projects()[1].history_ids = [1, 'two', 'new-work']
    expect(await f.organization.undoArtworkOrganization(receipt)).toEqual({ restored: 1, skipped: 1 })
    expect(f.history()[0].project).toBe('later')
    expect(f.projects().map(project => project.history_ids)).toEqual([['two'], [1, 'new-work']])
  })

  it('tag-only undo permits later membership edits and keeps generation tags separate', async () => {
    const f = fixture()
    const receipt = await f.organization.organizeArtworks({ ids: [1], collectionTags: { add: ['favorite'] } })
    f.history()[0].project = 'later'
    f.projects()[0].history_ids = ['two']
    expect(await f.organization.undoArtworkOrganization(receipt)).toEqual({ restored: 1, skipped: 0 })
    expect(f.history()[0]).toMatchObject({ project: 'later', manual_tags: ['generated'], collectionTags: ['draft'] })
    expect(f.projects()[0].history_ids).toEqual(['two'])
  })

  it('removes all old album references and can restore a missing project field', async () => {
    const f = fixture()
    delete f.history()[0].project
    f.projects()[1].history_ids = [1]
    const receipt = await f.organization.organizeArtworks({ ids: [1], projectId: null })
    expect(f.projects().map(project => project.history_ids)).toEqual([['two'], []])
    await f.organization.undoArtworkOrganization(receipt)
    expect(f.projects().map(project => project.history_ids)).toEqual([[1, 'two'], [1]])
    expect(f.history()[0]).not.toHaveProperty('project')
  })

  it('reads an uncertain committed write before reporting success, and preserves the undo receipt', async () => {
    const f = fixture()
    f.commit.mockImplementationOnce(async entries => { entries.forEach(entry => f.data.set(entry.key, structuredClone(entry.value))); throw new Error('reply lost') })
    const receipt = await f.organization.organizeArtworks({ ids: [1], collectionTags: { add: ['review'] } })
    expect(f.history()[0].collectionTags).toEqual(['draft', 'review'])
    expect(await f.organization.undoArtworkOrganization(receipt)).toEqual({ restored: 1, skipped: 0 })
  })

  it('does not mutate snapshots after a failed commit or missing artwork', async () => {
    const f = fixture(), before = structuredClone([...f.data])
    f.commit.mockRejectedValueOnce(new Error('quota'))
    await expect(f.organization.organizeArtworks({ ids: [1], projectId: 7 })).rejects.toThrow('quota')
    expect([...f.data]).toEqual(before)
    await expect(f.organization.organizeArtworks({ ids: [1, 'missing'], projectId: 7 })).rejects.toThrow('部分作品')
    expect([...f.data]).toEqual(before)
    await expect(f.organization.organizeArtworks({ ids: [1], projectId: 'missing' })).rejects.toThrow('画册已不存在')
    await expect(f.organization.organizeArtworks({ ids: [1], collectionTags: { add: ['x'.repeat(65)] } })).rejects.toThrow('整理标签')
  })

  it('keeps an existing album position instead of moving an unchanged member to the end', async () => {
    const f = fixture()
    const receipt = await f.organization.organizeArtworks({ ids: [1], projectId: 'old' })
    expect(receipt.changes).toEqual([])
    expect(f.projects()[0].history_ids).toEqual([1, 'two'])
    expect(f.commit).not.toHaveBeenCalled()
  })

  it('preserves actual undo authority when no-op retries exceed the receipt budget', async () => {
    const f = fixture(), input = { ids: [1], collectionTags: { add: ['chosen'] } }
    const receipt = await f.organization.organizeArtworks(input)
    for (let retry = 0; retry <= ARTWORK_ORGANIZATION_RECEIPT_LIMIT; retry++) {
      expect((await f.organization.organizeArtworks(input)).changes).toEqual([])
    }
    expect(f.commit).toHaveBeenCalledOnce()
    expect(await f.organization.undoArtworkOrganization(receipt)).toEqual({ restored: 1, skipped: 0 })
    expect(f.history()[0].collectionTags).toEqual(['draft'])
  })
})

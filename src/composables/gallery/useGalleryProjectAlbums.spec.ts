import { describe, expect, it, vi } from 'vitest'
import { computed, reactive, ref } from 'vue'
import type { SmartAlbumRule } from '@/application/artwork/smartAlbums'
import type { ArtworkRecord } from '@/types/artwork'
import type { GalleryProject } from './galleryStorage'
import { artworkCharacterIds, createSmartAlbumMatcher, UNASSIGNED_CHARACTER_ID } from './galleryAlbumRules'
import * as galleryHelpers from './galleryHelpers'
import { useGalleryProjectAlbums } from './useGalleryProjectAlbums'

function fixture() {
  const projects = ref<GalleryProject[]>([
    { id: 'first', title: '雨后的来信', history_ids: [1, 1, 2, 3, 'gone'] },
    { id: 'empty', title: '空相册', history_ids: ['gone'] },
  ])
  const history = ref<ArtworkRecord[]>([{ id: 1, timestamp: 100 }, { id: 2, timestamp: 200 }, { id: 3, timestamp: 300 }])
  const thumbUrls = reactive<Record<string, string>>({})
  const cardUrls = reactive<Record<string, string>>({})
  return { projects, history, thumbUrls, cardUrls }
}

function rule(values: Partial<SmartAlbumRule> = {}): SmartAlbumRule {
  return { characterId: '', tags: [], tagMatch: 'all', favoriteOnly: false, search: '', projectId: '', ...values }
}

describe('project album presentation', () => {
  it('counts live, distinct project members and hides empty albums', () => {
    const state = fixture()
    const { albums } = useGalleryProjectAlbums(state)
    expect(albums.value).toEqual([{ id: 'first', title: '雨后的来信', kind: 'manual', count: 3, covers: [] }])
    expect(state.projects.value[0].history_ids).toEqual([1, 1, 2, 3, 'gone'])
    state.projects.value[0].history_ids = ['1', 2]
    expect(albums.value[0].count).toBe(1)
    state.history.value = []
    expect(albums.value).toEqual([])
  })

  it('borrows thumbnails before HD URLs and reacts to cache eviction without loading originals', () => {
    const state = fixture()
    state.thumbUrls[1] = 'data:image/png;base64,thumb'
    state.cardUrls[1] = 'blob:original-one'
    state.cardUrls[2] = 'blob:original-two'
    state.history.value[2].image_url = '/not-loaded.png'
    const { albums } = useGalleryProjectAlbums(state)
    expect(albums.value[0].covers).toEqual([
      { id: 2, src: 'blob:original-two' },
      { id: 1, src: 'data:image/png;base64,thumb' },
    ])
    delete state.cardUrls[2]
    expect(albums.value[0].covers.map(cover => cover.id)).toEqual([1])
    state.thumbUrls[3] = 'data:image/webp;base64,new-thumb'
    expect(albums.value[0].covers.map(cover => cover.id)).toEqual([3, 1])
  })

  it('limits covers to three and rejects unsupported cached URL schemes', () => {
    const state = fixture()
    state.history.value.push({ id: 4, timestamp: 400 }, { id: 5, timestamp: 500 })
    state.projects.value[0].history_ids.push(4, 5)
    for (const id of [1, 2, 3, 4]) state.thumbUrls[id] = `data:image/png;base64,${id}`
    state.thumbUrls[5] = 'javascript:alert(1)'
    const { albums, resolvePreviewItems } = useGalleryProjectAlbums(state)
    expect(albums.value[0].count).toBe(5)
    expect(albums.value[0].covers.map(cover => cover.id)).toEqual([4, 3, 2])
    expect(resolvePreviewItems('albums', ['first']).map(item => item.id)).toEqual([3, 4, 5])
    expect(state.history.value.map(item => item.id)).toEqual([1, 2, 3, 4, 5])
  })

  it('groups explicit character identities across outfits, with shared artwork and recent activity first', () => {
    const state = fixture()
    state.projects.value = []
    state.history.value = [
      { id: 1, timestamp: 100, characterId: ' nene ', character: 'natsume', outfitId: 'uniform' },
      { id: 2, timestamp: 300, character: 'nene', outfitId: 'kimono' },
      { id: 3, timestamp: 200, character: 'triad' },
      { id: 4, timestamp: 600, characterId: 'kurumi/key ?', characterIds: [' nene ', 'nene'] },
      { id: 5, timestamp: 500, character: 'both' },
      { id: 6, timestamp: 50, manual_tags: ['nene'], prompt: 'nene portrait' },
    ]
    const saved = JSON.stringify(state.history.value)
    const { characterAlbums, resolvePreviewItems } = useGalleryProjectAlbums({ ...state,
      characterName: id => id === 'nene' ? '绫地宁宁' : id === 'kurumi/key ?' ? '时崎狂三' : '四季夏目' })
    expect(characterAlbums.value.map(album => [album.characterId, album.title, album.count])).toEqual([
      ['kurumi/key ?', '时崎狂三', 1], ['nene', '绫地宁宁', 5], ['natsume', '四季夏目', 2],
      [UNASSIGNED_CHARACTER_ID, '未标注角色', 1],
    ])
    expect(characterAlbums.value[0].id).toBe(`character:${encodeURIComponent('kurumi/key ?')}`)
    const visibleIds = characterAlbums.value.map(album => album.id)
    expect(resolvePreviewItems('characters', visibleIds).map(item => item.id)).toEqual([2, 3, 4, 5, 6])
    expect(resolvePreviewItems('characters', ['character:nene']).map(item => item.id)).toEqual([2, 4, 5])
    expect(JSON.stringify(state.history.value)).toBe(saved)
    expect(artworkCharacterIds(state.history.value[0])).toEqual(['nene'])
    expect(createSmartAlbumMatcher(rule({ characterId: UNASSIGNED_CHARACTER_ID }), [])(state.history.value[5])).toBe(true)
    state.history.value[0].outfitId = 'evening'
    expect(characterAlbums.value.find(album => album.characterId === 'nene')?.title).toBe('绫地宁宁')
    state.history.value.push({ id: 7, timestamp: 700, characterId: 'nene' })
    expect(characterAlbums.value[0]).toMatchObject({ characterId: 'nene', count: 6 })
    expect(resolvePreviewItems('characters', visibleIds).map(item => item.id)).toContain(7)
  })

  it('keeps smart albums live with AND conditions, exact saved tags, and strict manual source membership', () => {
    const state = fixture()
    state.history.value = [
      { id: 1, timestamp: 100, characterId: 'nene', favorite: true, collectionTags: [' 和服 '], manual_tags: ['夜景'], prompt: 'PORTRAIT autumn' },
      { id: 2, timestamp: 200, characterId: 'nene', collectionTags: ['和服'], prompt: 'portrait autumn 夜景' },
      { id: 3, timestamp: 300, character: 'natsume', favorite: true, tags: ['和服', '夜景'], prompt: 'portrait autumn' },
      { id: 4, timestamp: 400, characterId: 'nene', favorite: true, tags: ['和服', '夜景'], prompt: 'portrait spring' },
    ]
    state.projects.value.push({ id: 'smart', title: '宁宁的和服夜景', history_ids: [], smartRule: rule({
      characterId: 'nene', tags: ['和服', '夜景'], favoriteOnly: true, search: 'Portrait AUTUMN', projectId: 'first',
    }) })
    const before = JSON.stringify(state.history.value)
    const { albums } = useGalleryProjectAlbums(state)
    const smart = () => albums.value.find(album => album.id === 'smart')!
    expect(smart()).toMatchObject({ kind: 'smart', count: 1 })
    expect(smart().ruleSummary).toContain('绫地宁宁')
    expect(JSON.stringify(state.history.value)).toBe(before)
    state.history.value[0].favorite = false
    expect(smart().count).toBe(0)
    state.history.value[0].favorite = true
    state.history.value[2].characterId = 'nene'
    expect(smart().count).toBe(2)
    state.history.value[0].manual_tags = []
    expect(smart().count).toBe(1)
    const savedRule = state.projects.value.find(project => project.id === 'smart')!.smartRule!
    savedRule.tagMatch = 'any'
    expect(smart().count).toBe(2)
    savedRule.tagMatch = 'all'
    savedRule.favoriteOnly = false
    // A prompt containing 夜景 does not supply a saved tag.
    expect(smart().count).toBe(1)
    state.projects.value[0].history_ids = ['3']
    expect(smart().count).toBe(0)
    state.projects.value = state.projects.value.filter(project => project.id !== 'first')
    expect(smart().count).toBe(0)
    state.projects.value.push({ id: 'broken', title: '损坏规则', history_ids: [1, 2, 3], smartRule: { tags: [] } as unknown as SmartAlbumRule })
    expect(albums.value.map(album => album.id)).toEqual(['smart'])
  })

  it('prepares source membership once instead of scanning the album for each artwork', () => {
    const history = Array.from({ length: 400 }, (_, id) => ({ id }))
    const projects = [{ id: 'source', title: 'Source', history_ids: history.map(item => item.id) }]
    const find = vi.spyOn(projects, 'find')
    const includes = vi.spyOn(projects[0].history_ids, 'includes')
    const matches = createSmartAlbumMatcher(rule({ projectId: 'source' }), projects)
    expect(history.filter(item => matches(item))).toHaveLength(400)
    expect(matches({ id: '1' })).toBe(false)
    expect(matches({ id: 401 })).toBe(false)
    expect(find.mock.calls.length).toBeLessThanOrEqual(1)
    expect(includes).not.toHaveBeenCalled()
  })

  it('reuses prepared search metadata when cover caches arrive or are evicted', () => {
    const state = fixture()
    state.history.value[0].prompt = 'portrait'
    state.projects.value.push({ id: 'smart', title: '肖像', history_ids: [], smartRule: rule({ search: 'portrait' }) })
    const searchSpy = vi.spyOn(galleryHelpers, 'searchHaystack')
    const { albums, resolvePreviewItems } = useGalleryProjectAlbums(state)
    const previewItems = computed(() => resolvePreviewItems('albums', ['smart']))
    expect(albums.value.find(album => album.id === 'smart')?.count).toBe(1)
    expect(searchSpy).toHaveBeenCalledTimes(3)
    const preparedPreviews = previewItems.value
    expect(preparedPreviews.map(item => item.id)).toEqual([1])
    state.thumbUrls[1] = 'data:image/png;base64,portrait'
    expect(albums.value.find(album => album.id === 'smart')?.covers).toEqual([{ id: 1, src: state.thumbUrls[1] }])
    delete state.thumbUrls[1]
    expect(albums.value.find(album => album.id === 'smart')?.covers).toEqual([])
    expect(previewItems.value).toBe(preparedPreviews)
    expect(searchSpy).toHaveBeenCalledTimes(3)
  })
})

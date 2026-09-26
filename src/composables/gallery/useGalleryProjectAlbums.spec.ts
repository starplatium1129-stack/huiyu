import { describe, expect, it } from 'vitest'
import { reactive, ref } from 'vue'
import type { ArtworkRecord } from '@/types/artwork'
import type { GalleryProject } from './galleryStorage'
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

describe('project album presentation', () => {
  it('counts live, distinct project members and hides empty albums', () => {
    const state = fixture()
    const { albums } = useGalleryProjectAlbums(state)
    expect(albums.value).toEqual([{ id: 'first', title: '雨后的来信', count: 3, covers: [] }])
    expect(state.projects.value[0].history_ids).toEqual([1, 1, 2, 3, 'gone'])
    state.history.value = []
    expect(albums.value).toEqual([])
  })

  it('uses the same strict ID membership as the gallery project filter', () => {
    const state = fixture()
    state.projects.value[0].history_ids = ['1', 2]
    const { albums } = useGalleryProjectAlbums(state)
    expect(albums.value[0].count).toBe(1)
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
    const { albums } = useGalleryProjectAlbums(state)
    expect(albums.value[0].count).toBe(5)
    expect(albums.value[0].covers.map(cover => cover.id)).toEqual([4, 3, 2])
    expect(state.history.value.map(item => item.id)).toEqual([1, 2, 3, 4, 5])
  })
})

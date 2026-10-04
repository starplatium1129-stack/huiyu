import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, KeepAlive, nextTick, reactive, ref } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { ArtworkRecord } from '@/types/artwork'
import type { GalleryProject } from './galleryStorage'
import { useGalleryCollections } from './useGalleryCollections'

const repository = vi.hoisted(() => ({ saveSmartAlbum: vi.fn(), deleteSmartAlbum: vi.fn(), readProjects: vi.fn() }))
const confirm = vi.hoisted(() => vi.fn())
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: repository }))
vi.mock('@/composables/useConfirm', () => ({ confirmAction: confirm }))
vi.mock('@/utils/scrollAnchor', () => ({ captureScrollAnchor: () => null, restoreScrollAnchor: () => () => {} }))
const wrappers: VueWrapper[] = []
beforeEach(() => vi.clearAllMocks())
afterEach(() => wrappers.splice(0).forEach(wrapper => wrapper.unmount()))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function setup() {
  const active = ref(true)
  const options = {
    history: ref<ArtworkRecord[]>([{ id: 1, favorite: true }]), projects: ref<GalleryProject[]>([]),
    thumbUrls: reactive<Record<string, string>>({}), cardUrls: reactive<Record<string, string>>({}),
    characterName: (id: string | undefined) => id || '', characterFilter: ref(''), projectFilter: ref('existing'),
    tagFilter: ref(''), searchQuery: ref(''), favoriteOnly: ref(false), resetGalleryFilters: vi.fn(),
    collectionPreviewItems: ref<ArtworkRecord[] | null>(null), showToast: vi.fn(),
  }
  let collections!: ReturnType<typeof useGalleryCollections>
  const Gallery = defineComponent({ setup() { collections = useGalleryCollections(options); return () => h('div') } })
  const wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => active.value ? h(Gallery) : null }) }))
  wrappers.push(wrapper)
  return { options, collections, active }
}

describe('smart album editor lifecycle', () => {
  it('keeps overview thumbnail demand stable as covers arrive, but updates visible membership', () => {
    const { options, collections } = setup()
    options.projects.value = [{ id: 'existing', title: 'Album', history_ids: [1] }]
    collections.albumsOpen.value = true
    expect(collections.syncPreviews.value).toEqual([])
    collections.visibleAlbumIds.value = ['existing']
    const requested = collections.syncPreviews.value
    expect(requested?.map(item => item.id)).toEqual([1])
    options.thumbUrls[1] = 'data:image/jpeg;base64,cover'
    expect(collections.albums.value[0].covers).toHaveLength(1)
    expect(collections.syncPreviews.value).toBe(requested)
    delete options.thumbUrls[1]
    expect(collections.syncPreviews.value).toBe(requested)
    options.history.value.push({ id: 2 })
    options.projects.value[0].history_ids.push(2)
    expect(collections.syncPreviews.value?.map(item => item.id)).toEqual([1, 2])
    collections.visibleAlbumIds.value = []
    expect(collections.syncPreviews.value).toEqual([])
  })

  it('only computes previews while the editor is open', () => {
    const { options, collections } = setup()
    expect(collections.previewItems.value).toEqual([])
    collections.newSmartAlbum()
    expect(collections.previewItems.value.map(item => item.id)).toEqual([1])
    options.history.value.push({ id: 2 })
    expect(collections.previewItems.value.map(item => item.id)).toEqual([1, 2])
    collections.editorOpen.value = false
    expect(collections.previewItems.value).toEqual([])
  })

  it.each([false, true])('publishes a late save without navigating after leaving (return=%s)', async returnToGallery => {
    const { options, collections, active } = setup()
    const pending = deferred<GalleryProject>()
    repository.saveSmartAlbum.mockReturnValueOnce(pending.promise)
    collections.newSmartAlbum()
    collections.editorTitle.value = 'Saved album'
    const saving = collections.save()
    active.value = false
    await nextTick()
    expect(collections.editorOpen.value).toBe(false)
    if (returnToGallery) { active.value = true; await nextTick() }
    pending.resolve({ id: 'saved', title: 'Saved album', history_ids: [], smartRule: collections.editorRule.value })
    await saving
    expect(options.projects.value.map(project => project.id)).toEqual(['saved'])
    expect(options.projectFilter.value).toBe('existing')
    expect(options.resetGalleryFilters).not.toHaveBeenCalled()
    expect(options.showToast).not.toHaveBeenCalled()
    expect(collections.saving.value).toBe(false)
  })

  it('does not start a deletion when its confirmation outlives the gallery visit', async () => {
    const { options, collections, active } = setup()
    options.projects.value = [{ id: 'smart', title: 'Smart', history_ids: [], smartRule: collections.editorRule.value }]
    const pending = deferred<boolean>()
    confirm.mockReturnValueOnce(pending.promise)
    const removing = collections.removeSmartAlbum('smart')
    active.value = false
    await nextTick()
    active.value = true
    await nextTick()
    pending.resolve(true)
    await removing
    expect(repository.deleteSmartAlbum).not.toHaveBeenCalled()
    expect(options.projects.value).toHaveLength(1)
  })

  it('publishes an acknowledged deletion without resetting the next visit', async () => {
    const { options, collections, active } = setup()
    options.projects.value = [{ id: 'smart', title: 'Smart', history_ids: [], smartRule: collections.editorRule.value }]
    options.projectFilter.value = 'smart'
    confirm.mockResolvedValueOnce(true)
    const pending = deferred<void>()
    repository.deleteSmartAlbum.mockReturnValueOnce(pending.promise)
    const removing = collections.removeSmartAlbum('smart')
    await nextTick()
    expect(repository.deleteSmartAlbum).toHaveBeenCalledWith('smart')
    active.value = false
    await nextTick()
    active.value = true
    await nextTick()
    pending.resolve()
    await removing
    expect(options.projects.value).toEqual([])
    expect(options.resetGalleryFilters).not.toHaveBeenCalled()
    expect(options.showToast).not.toHaveBeenCalled()
  })
})

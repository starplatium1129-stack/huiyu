import { expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mocks, Observer, record, setup } from './galleryWorkspaceTestHarness'
import type { ArtworkLibrarySnapshot } from '@/application/artwork/artworkRepository'

it('restores library filters after its snapshot without waiting for scene or LoRA labels', async () => {
  let library!: (value: ArtworkLibrarySnapshot) => void, home!: () => void, lora!: () => void
  mocks.snapshot.mockImplementationOnce(() => new Promise(resolve => { library = resolve }))
  mocks.sceneStore.loadHome.mockImplementationOnce(() => new Promise<void>(resolve => { home = resolve }))
  mocks.sceneStore.loadLoraCatalog.mockImplementationOnce(() => new Promise<void>(resolve => { lora = resolve }))
  mocks.route.query = { project: 'album', q: 'Saved title' }
  const { gallery } = await setup()
  expect(gallery.galleryLoading.value).toBe(true)
  expect(gallery.projectFilter.value).toBe('')
  expect(mocks.sceneStore.load).not.toHaveBeenCalled()
  expect(mocks.sceneStore.loadHome).toHaveBeenCalledOnce()
  expect(mocks.sceneStore.loadLoraCatalog).toHaveBeenCalledOnce()
  const item = { ...record(1), scene: 'scene-1', sceneTitle: 'Saved title', lora: 'lora-1' }
  library({ history: [item, { ...record(2), sceneTitle: 'Saved title' }], projects: [{ id: 'album', history_ids: [1] }] })
  await flushPromises()
  expect(gallery.galleryLoading.value).toBe(false)
  expect(gallery.projectFilter.value).toBe('album')
  expect(gallery.projectUnavailable.value).toBe(false)
  expect(gallery.visible.value.map(value => value.id)).toEqual([1])
  expect(gallery.thumbUrls[1]).toBe('data:image/jpeg;base64,thumb')
  expect(gallery.sceneTitle(item.scene, item)).toBe('Saved title')
  mocks.sceneStore.scenes = [{ id: 'scene-1', title: 'Catalog title' }]
  mocks.sceneStore.popularCharacters = [{ id: 'fixture', displayName: 'Fixture character' }]
  home(); await flushPromises()
  expect(gallery.sceneTitle('scene-1')).toBe('Catalog title')
  expect(gallery.characterName('fixture')).toBe('Fixture character')
  expect(gallery.sceneTitle(item.scene, item)).toBe('Saved title')
  mocks.sceneStore.loras = [{ id: 'lora-1', name: 'Catalog LoRA' }]
  lora(); await flushPromises()
  gallery.openViewer(0)
  expect(gallery.facts.value).toContainEqual({ label: 'LoRA', value: 'Catalog LoRA' })
  expect(gallery.visible.value.map(value => value.id)).toEqual([1])
})

it('keeps saved names, search and raw recipe labels usable when supplemental catalogs are offline', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.sceneStore.loadHome.mockRejectedValueOnce(new Error('offline'))
  mocks.sceneStore.loadLoraCatalog.mockRejectedValueOnce(new Error('offline'))
  const item = { ...record(1), sceneTitle: 'Offline title', lora: 'saved-lora' }
  mocks.snapshot.mockResolvedValueOnce({ history: [item], projects: [] })
  mocks.route.query = { q: 'Offline title' }
  const { gallery } = await setup()
  expect(gallery.visible.value.map(value => value.id)).toEqual([1])
  expect(gallery.sceneTitle(null, item)).toBe('Offline title')
  expect(gallery.galleryError.value).toBe('')
  gallery.openViewer(0)
  expect(gallery.facts.value).toContainEqual({ label: 'LoRA', value: 'saved-lora' })
})

it('retries a card that returns before its cancelled read settles without losing the new read ownership', async () => {
  const reads: Array<{ signal: AbortSignal; finish(blob: Blob): void }> = []
  mocks.getImage.mockImplementation((_id: string, signal: AbortSignal) => new Promise<Blob>(finish => { reads.push({ signal, finish }) }))
  const env = await setup()
  await env.intersect()
  env.gallery.searchQuery.value = 'no-matching-artwork'
  await flushPromises()
  expect(reads[0].signal.aborted).toBe(true)
  env.gallery.searchQuery.value = ''
  await flushPromises()
  await env.intersect()
  expect(reads).toHaveLength(2)
  reads[0].finish(new Blob(['cancelled original']))
  await flushPromises()
  await env.intersect()
  expect(reads).toHaveLength(2)
  expect(env.gallery.cardUrls).toEqual({})
  reads[1].finish(new Blob(['current original']))
  await flushPromises()
  expect(env.gallery.cardUrls[1]).toBe('blob:gallery-1')
  expect(env.gallery.missingImageIds.value.size).toBe(0)
  expect(URL.createObjectURL).toHaveBeenCalledOnce()
})

it('cancels originals outside the scroll margin and drops their queued reads while retaining the wall', async () => {
  mocks.snapshot.mockResolvedValue({ history: Array.from({ length: 8 }, (_, index) => record(index + 1)), projects: [] })
  const reads: Array<{ id: string; signal: AbortSignal; finish(blob: Blob): void }> = []
  mocks.getImage.mockImplementation((id: string, signal: AbortSignal) => new Promise<Blob>((finish, reject) => {
    reads.push({ id, signal, finish })
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  }))
  const env = await setup()
  const ordered = env.gallery.pagedVisible.value
  await env.intersect()
  const observer = Observer.instances.find(value => value.options.rootMargin === '600px 0px')!
  const leaving = [...observer.elements].slice(0, 5)
  observer.callback(leaving.map(target => ({ target, isIntersecting: false }) as IntersectionObserverEntry), observer as unknown as IntersectionObserver)
  await flushPromises()
  expect(reads.slice(0, 4).every(read => read.signal.aborted)).toBe(true)
  expect(reads.map(read => read.id)).toEqual([...ordered.slice(0, 4), ...ordered.slice(5)].map(item => item.image_id))
  expect(env.gallery.pagedVisible.value).toHaveLength(8)
  expect(env.gallery.missingImageIds.value.size).toBe(0)
  observer.callback([{ target: leaving[0], isIntersecting: true } as IntersectionObserverEntry], observer as unknown as IntersectionObserver)
  await flushPromises()
  expect(reads.at(-1)?.id).toBe(ordered[0].image_id)
  reads.at(-1)!.finish(new Blob(['returned image']))
  await flushPromises()
  expect(env.gallery.cardUrls[ordered[0].id]).toBe('blob:gallery-1')
})

it('coalesces a bulk media replacement into one wall scan and observes the current cards', async () => {
  const history = Array.from({ length: 60 }, (_, index) => record(index + 1))
  mocks.snapshot.mockResolvedValue({ history, projects: [] })
  const { gallery } = await setup()
  const scan = vi.spyOn(gallery.shellEl.value!, 'querySelectorAll')
  const observer = Observer.instances.find(value => value.options.rootMargin === '600px 0px')!
  gallery.history.value = history.map(item => ({ ...item, image_id: `${item.image_id}-replacement` }))
  await flushPromises()
  expect(scan).toHaveBeenCalledTimes(1)
  expect(observer.elements.size).toBe(60)
  observer.intersect()
  await flushPromises()
  expect(mocks.getImage.mock.calls.every(([id]) => id.endsWith('-replacement'))).toBe(true)
  expect(mocks.getImage).toHaveBeenCalledTimes(60)
})

it('keeps a viewer tag selection when its closing transition ends before the URL debounce', async () => {
  mocks.snapshot.mockResolvedValue({ history: [
    { ...record(1), manual_tags: ['春日'] }, record(2), { ...record(3), manual_tags: ['春日'] },
  ], projects: [] })
  const { gallery } = await setup()
  vi.useFakeTimers()
  gallery.openViewer(0)
  gallery.closeViewer()
  gallery.tagFilter.value = '春日'
  await flushPromises()
  gallery.onViewerClosed()
  expect(gallery.tagFilter.value).toBe('春日')
  expect(gallery.visible.value.map(item => item.id)).toEqual([3, 1])
  await vi.advanceTimersByTimeAsync(300)
  expect(mocks.replace).toHaveBeenLastCalledWith({ query: { tag: '春日' } })
})

it('observes cards moved between masonry columns after image measurement without restarting unchanged cards', async () => {
  mocks.snapshot.mockResolvedValue({ history: Array.from({ length: 12 }, (_, index) => record(index + 1)), projects: [] })
  const { gallery } = await setup(true)
  const observer = Observer.instances.find(value => value.options.rootMargin === '600px 0px')!
  const before = new Set(observer.elements)
  const observe = vi.spyOn(observer, 'observe')
  const initialGroups = gallery.masonryGroups.value
  const first = gallery.pagedVisible.value[0]
  gallery.measure(first, { target: { naturalWidth: 100, naturalHeight: 200 } } as unknown as Event)
  await flushPromises()
  expect(gallery.masonryGroups.value).toBe(initialGroups)
  expect(observe).not.toHaveBeenCalled()
  gallery.measure(first, { target: { naturalWidth: 100, naturalHeight: 600 } } as unknown as Event)
  await flushPromises()
  const current = new Set(gallery.shellEl.value!.querySelectorAll('.artwork'))
  const moved = [...current].filter(element => !before.has(element))
  expect(moved.length).toBeGreaterThan(0)
  expect(observer.elements.size).toBe(current.size)
  expect([...current].every(element => observer.elements.has(element))).toBe(true)
  expect(observe).toHaveBeenCalledTimes(moved.length)
  observer.callback(moved.map(target => ({ target, isIntersecting: true }) as IntersectionObserverEntry), observer as unknown as IntersectionObserver)
  await flushPromises()
  for (const element of moved) expect(gallery.cardUrls[(element as HTMLElement).dataset.cardId!]).toBeTruthy()
  observe.mockClear()
  first.image_id = 'replacement-in-place'
  await flushPromises()
  const replaced = gallery.shellEl.value!.querySelector(`[data-card-id="${first.id}"]`)!
  expect(observe).toHaveBeenCalledWith(replaced)
  observer.callback([{ target: replaced, isIntersecting: true } as IntersectionObserverEntry], observer as unknown as IntersectionObserver)
  await flushPromises()
  expect(mocks.getImage).toHaveBeenCalledWith('replacement-in-place', expect.any(AbortSignal))
})

import { expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mocks, record, setup } from './galleryWorkspaceTestHarness'
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

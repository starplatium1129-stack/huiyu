import { ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toggleFavoriteAction } from './galleryMutations'
import { loadGalleryStorageAction, type GalleryProject } from './galleryStorage'
import type { ArtworkRecord } from '@/types/artwork'
import type { ArtworkLibrarySnapshot } from '@/application/artwork/artworkRepository'
import { artworkRepository, configureArtworkRepository } from '@/storage/artworkRepository'

const original = artworkRepository
const storage = { read: vi.fn() }
beforeEach(() => {
  storage.read.mockReset()
  configureArtworkRepository({ ...original, readLibrarySnapshot: storage.read })
})
afterEach(() => configureArtworkRepository(original))
const snapshot = (id: string): ArtworkLibrarySnapshot => ({ history: [{ id, prompt: id }], projects: [] })
const context = () => ({ galleryLoading: ref(false), galleryError: ref(''), history: ref<ArtworkRecord[]>([{ id: 'existing', prompt: 'keep me' }]), projects: ref<GalleryProject[]>([]) })

it('an older load cannot overwrite a newer completed refresh', async () => {
  const ctx = context()
  let release!: (value: ArtworkLibrarySnapshot) => void
  storage.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    .mockResolvedValue(snapshot('new'))
  const old = loadGalleryStorageAction(ctx)
  await loadGalleryStorageAction(ctx)
  release(snapshot('old')); await old
  expect(ctx.history.value[0].id).toBe('new')
})

it('completion of an old request cannot clear the loading indicator of a newer request', async () => {
  const ctx = context()
  ctx.history.value = []
  let oldReply!: (value: ArtworkLibrarySnapshot) => void, newReply!: (value: ArtworkLibrarySnapshot) => void
  storage.read.mockImplementationOnce(() => new Promise(resolve => { oldReply = resolve }))
    .mockImplementationOnce(() => new Promise(resolve => { newReply = resolve }))
  const old = loadGalleryStorageAction(ctx)
  const latest = loadGalleryStorageAction(ctx)
  oldReply(snapshot('old')); await old
  expect(ctx.galleryLoading.value).toBe(true)
  newReply(snapshot('latest')); await latest
  expect(ctx.galleryLoading.value).toBe(false)
  expect(ctx.history.value[0].id).toBe('latest')
})

it('read failure preserves displayed artwork and the next load can recover', async () => {
  const ctx = context()
  storage.read.mockRejectedValueOnce(new Error('temporarily unavailable'))
  await loadGalleryStorageAction(ctx)
  expect(ctx.history.value[0].id).toBe('existing')
  expect(ctx.galleryLoading.value).toBe(false)
  expect(ctx.galleryError.value).toContain('temporarily unavailable')
  storage.read.mockResolvedValue(snapshot('new'))
  await loadGalleryStorageAction(ctx)
  expect(ctx.history.value[0].id).toBe('new')
  expect(ctx.galleryError.value).toBe('')
})

it('retains unchanged metadata references and still applies a later persisted change', async () => {
  const ctx = context(), previous = ctx.history.value
  storage.read.mockResolvedValueOnce({ history: [{ id: 'existing', prompt: 'keep me' }], projects: [] })
  await loadGalleryStorageAction(ctx)
  expect(ctx.history.value).toBe(previous)
  storage.read.mockResolvedValueOnce({ history: [{ id: 'existing', prompt: 'updated', favorite: true }], projects: [] })
  await loadGalleryStorageAction(ctx)
  expect(ctx.history.value).not.toBe(previous)
  expect(ctx.history.value[0]).toMatchObject({ prompt: 'updated', favorite: true })
})

it('keeps the last snapshot usable during refresh and replaces it with an authoritative empty snapshot', async () => {
  const ctx = context()
  ctx.projects.value = [{ id: 'album', title: 'Album', history_ids: ['existing'] }]
  const previousHistory = ctx.history.value, previousProjects = ctx.projects.value
  let reply!: (value: ArtworkLibrarySnapshot) => void
  storage.read.mockImplementationOnce(() => new Promise(resolve => { reply = resolve }))
  const refresh = loadGalleryStorageAction(ctx)
  expect(ctx.galleryLoading.value).toBe(false)
  expect(ctx.history.value).toBe(previousHistory)
  expect(ctx.projects.value).toBe(previousProjects)
  reply({ history: [], projects: [] }); await refresh
  expect(ctx.history.value).toEqual([])
  expect(ctx.projects.value).toEqual([])
})

it('keeps empty albums visible during refresh and ignores an obsolete rejection', async () => {
  const ctx = context()
  ctx.history.value = []
  ctx.projects.value = [{ id: 'empty-album', title: 'Empty album', history_ids: [] }]
  let reject!: (error: Error) => void
  storage.read.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    .mockRejectedValueOnce(new Error('current failure'))
  const old = loadGalleryStorageAction(ctx)
  expect(ctx.galleryLoading.value).toBe(false)
  await loadGalleryStorageAction(ctx)
  reject(new Error('obsolete failure')); await old
  expect(ctx.galleryError.value).toBe('current failure')
  expect(ctx.galleryLoading.value).toBe(false)
  expect(ctx.projects.value[0].id).toBe('empty-album')
})

it.each(['before', 'after'])('keeps the saved favorite when an older snapshot resolves %s the write', async order => {
  const ctx = context()
  let reply!: (value: ArtworkLibrarySnapshot) => void
  storage.read.mockImplementationOnce(() => new Promise(resolve => { reply = resolve }))
  let save!: (value: { updated: boolean }) => void
  configureArtworkRepository({ ...artworkRepository, patchArtwork: () => new Promise(resolve => { save = resolve }) })
  const refresh = loadGalleryStorageAction(ctx)
  const write = toggleFavoriteAction({ history: ctx.history, showToast: vi.fn() }, ctx.history.value[0])
  await Promise.resolve()
  const incoming = { history: [...snapshot('existing').history, { id: 'new-work' }], projects: [{ id: 'new-album', history_ids: ['new-work'] }] }
  if (order === 'before') { reply(incoming); await refresh }
  save({ updated: true }); await write
  if (order === 'after') { reply(incoming); await refresh }
  expect(ctx.history.value[0].favorite).toBe(true)
  expect(ctx.history.value.map(item => item.id)).toEqual(['existing', 'new-work'])
  expect(ctx.projects.value[0]).toMatchObject({ id: 'new-album', history_ids: ['new-work'] })
  expect(storage.read).toHaveBeenCalledOnce()
})

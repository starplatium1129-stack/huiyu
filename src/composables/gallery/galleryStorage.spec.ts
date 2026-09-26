import { ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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

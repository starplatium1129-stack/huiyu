import { beforeEach, expect, it, vi } from 'vitest'
import { importLocalImages } from './desktopImport'
import { artworkRepository } from '@/storage/artworkRepository'

vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { appendArtwork: vi.fn(), putImage: vi.fn(), deleteImage: vi.fn(), readArtwork: vi.fn(), cacheThumbnail: vi.fn(), withStaging: (work: () => Promise<unknown>) => work() } }))
const pngBytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII='), value => value.charCodeAt(0))
const file = { name: 'fixture.png', size: pngBytes.length, type: 'image/png', blob: new Blob([pngBytes], { type: 'image/png' }) }
beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.stubGlobal('Image', class {
    naturalWidth = 1; naturalHeight = 1; onload = () => {}
    set src(_value: string) { this.onload() }
  })
  vi.mocked(artworkRepository.putImage).mockResolvedValue('new-image')
  vi.mocked(artworkRepository.deleteImage).mockResolvedValue()
  vi.mocked(artworkRepository.readArtwork).mockResolvedValue(null)
  vi.mocked(artworkRepository.appendArtwork).mockResolvedValue()
  vi.mocked(artworkRepository.cacheThumbnail).mockResolvedValue()
})
it('stores an unspecified image MIME from its bytes instead of its filename', async () => {
  const blob = new File([pngBytes], 'photo.JPG', { lastModified: 123 })
  expect(await importLocalImages([{ name: blob.name, type: '', size: blob.size, blob }])).toEqual({ imported: 1, skipped: 0 })
  const stored = vi.mocked(artworkRepository.putImage).mock.calls[0]![0]
  expect(stored.type).toBe('image/png')
  expect(stored).toMatchObject({ name: 'photo.JPG', lastModified: 123 })
  expect(new Uint8Array(await stored.arrayBuffer())).toEqual(pngBytes)
  expect(artworkRepository.cacheThumbnail).toHaveBeenCalledWith('new-image', stored)
  expect(blob.type).toBe('')
})
it.each([
  ['vector.svg', 'image/svg+xml'],
  ['photo.heic', 'image/heic'],
  ['disguised.png', 'image/png'],
])('does not store unsupported bytes even with an image name or MIME: %s', async (name, type) => {
  const blob = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type })
  expect(await importLocalImages([{ name, type, size: blob.size, blob }])).toEqual({ imported: 0, skipped: 1 })
  expect(artworkRepository.putImage).not.toHaveBeenCalled()
  expect(artworkRepository.appendArtwork).not.toHaveBeenCalled()
})
it('uses the detected format when a supported filename declares the wrong image MIME', async () => {
  const blob = new File([pngBytes], 'photo.JPG', { type: 'image/jpeg', lastModified: 123 })
  expect(await importLocalImages([{ name: blob.name, type: blob.type, size: blob.size, blob }])).toEqual({ imported: 1, skipped: 0 })
  const stored = vi.mocked(artworkRepository.putImage).mock.calls[0]![0]
  expect(stored).toMatchObject({ name: 'photo.JPG', type: 'image/png', lastModified: 123 })
  expect(new Uint8Array(await stored.arrayBuffer())).toEqual(pngBytes)
})
it('reads back a committed import after a lost acknowledgement', async () => {
  vi.mocked(artworkRepository.appendArtwork).mockImplementation(async entry => {
    vi.mocked(artworkRepository.readArtwork).mockResolvedValue(entry)
    throw new Error('ack lost')
  })
  expect(await importLocalImages([file])).toEqual({ imported: 1, skipped: 0 })
  expect(artworkRepository.deleteImage).not.toHaveBeenCalled()
})
it.each(['missing', 'unreadable', 'wrong-image'])('retains the original for an unconfirmed %s record', async mode => {
  vi.mocked(artworkRepository.appendArtwork).mockImplementation(async entry => {
    if (mode === 'unreadable') vi.mocked(artworkRepository.readArtwork).mockRejectedValue(new Error('offline'))
    if (mode === 'wrong-image') vi.mocked(artworkRepository.readArtwork).mockResolvedValue({ ...entry, image_id: 'other-image' })
    throw new Error('ack lost')
  })
  expect(await importLocalImages([file])).toEqual({ imported: 0, skipped: 1 })
  expect(artworkRepository.deleteImage).not.toHaveBeenCalled()
  expect(console.warn).toHaveBeenCalledWith('[desktop-import] commit unknown; image retained', expect.objectContaining({
    operationId: expect.any(String), imageId: 'new-image',
  }))
})
it('imports a batch without reading any complete or single-record history on success', async () => {
  const files = [...Array.from({ length: 10 }, () => file),
    { ...file, name: 'notes.txt', type: 'text/plain' }, { ...file, size: 25 * 1024 * 1024 }]
  expect(await importLocalImages(files)).toEqual({ imported: 8, skipped: 4 })
  expect(artworkRepository.appendArtwork).toHaveBeenCalledTimes(8)
  expect(artworkRepository.putImage).toHaveBeenCalledTimes(8)
  expect(artworkRepository.readArtwork).not.toHaveBeenCalled()
})
it('reports failed compensation without aborting the remaining batch', async () => {
  vi.spyOn(URL, 'createObjectURL').mockImplementationOnce(() => { throw new Error('measure failed') })
  vi.mocked(artworkRepository.deleteImage).mockRejectedValueOnce(new Error('cleanup failed'))
  expect(await importLocalImages([file, file])).toEqual({ imported: 1, skipped: 1 })
  expect(console.warn).toHaveBeenCalledWith('[desktop-import] image cleanup failed', expect.objectContaining({
    operationId: expect.any(String), imageId: 'new-image', cleanupError: expect.any(Error),
  }))
})

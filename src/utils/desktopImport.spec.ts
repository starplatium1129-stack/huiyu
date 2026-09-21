import { beforeEach, expect, it, vi } from 'vitest'
import { importLocalImages } from './desktopImport'
import { imgDelete, imgPut } from '@/composables/useImageStore'
import { kvGet } from '@/composables/useKVStore'
import { artworkRepository } from '@/storage/artworkRepository'

vi.mock('@/composables/useImageStore', () => ({ imgPut: vi.fn(), imgDelete: vi.fn() }))
vi.mock('@/composables/useKVStore', () => ({ kvGet: vi.fn(), kvSet: vi.fn() }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { appendArtwork: vi.fn() } }))
vi.mock('@/storage/artworkSession', () => ({ withArtworkStaging: (work: () => Promise<unknown>) => work() }))
vi.mock('./imageThumb', () => ({ blobThumbDataUrl: vi.fn(async () => null), thumbKey: (id: string) => id }))
const file = { name: 'fixture.png', size: 1, type: 'image/png', blob: new Blob(['a']) }
beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.stubGlobal('Image', class {
    naturalWidth = 1; naturalHeight = 1; onload = () => {}
    set src(_value: string) { this.onload() }
  })
  vi.mocked(imgPut).mockResolvedValue('new-image')
  vi.mocked(imgDelete).mockResolvedValue()
  vi.mocked(kvGet).mockResolvedValue([])
  vi.mocked(artworkRepository.appendArtwork).mockResolvedValue([])
})
it('reads back a committed import after a lost acknowledgement', async () => {
  vi.mocked(artworkRepository.appendArtwork).mockImplementation(async entry => {
    vi.mocked(kvGet).mockResolvedValue([entry])
    throw new Error('ack lost')
  })
  expect(await importLocalImages([file])).toEqual({ imported: 1, skipped: 0 })
  expect(imgDelete).not.toHaveBeenCalled()
})
it.each(['missing', 'unreadable', 'wrong-image'])('retains the original for an unconfirmed %s record', async mode => {
  vi.mocked(artworkRepository.appendArtwork).mockImplementation(async entry => {
    if (mode === 'unreadable') vi.mocked(kvGet).mockRejectedValue(new Error('offline'))
    if (mode === 'wrong-image') vi.mocked(kvGet).mockResolvedValue([{ ...entry, image_id: 'other-image' }])
    throw new Error('ack lost')
  })
  expect(await importLocalImages([file])).toEqual({ imported: 0, skipped: 1 })
  expect(imgDelete).not.toHaveBeenCalled()
  expect(console.warn).toHaveBeenCalledWith('[desktop-import] commit unknown; image retained', expect.objectContaining({
    operationId: expect.any(String), imageId: 'new-image',
  }))
})
it('reports failed compensation without aborting the remaining batch', async () => {
  vi.spyOn(URL, 'createObjectURL').mockImplementationOnce(() => { throw new Error('measure failed') })
  vi.mocked(imgDelete).mockRejectedValueOnce(new Error('cleanup failed'))
  expect(await importLocalImages([file, file])).toEqual({ imported: 1, skipped: 1 })
  expect(console.warn).toHaveBeenCalledWith('[desktop-import] image cleanup failed', expect.objectContaining({
    operationId: expect.any(String), imageId: 'new-image', cleanupError: expect.any(Error),
  }))
})

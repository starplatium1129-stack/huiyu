import type { CompanionDesktopBridge } from '@/types/desktop'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { artworkRepository } from '@/storage/artworkRepository'
import { useGalleryExports } from './useGalleryExports'
import { extractPngParameters } from '@/utils/pngMetadata'

vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { getImage: vi.fn() } }))
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII='), c => c.charCodeAt(0))
function setup() {
  const current = ref({ id: 'artwork-one', prompt: 'A quiet room', cfg: 0, seed: 0 })
  const showToast = vi.fn()
  const deps = { current, stamp: () => 0, sceneTitle: () => '作品', characterName: () => '', showToast }
  const exports = useGalleryExports(deps as unknown as Parameters<typeof useGalleryExports>[0])
  return { ...exports, current, showToast }
}
beforeEach(() => {
  vi.mocked(artworkRepository.getImage).mockReset()
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); desktopFixture.current = undefined })

describe('gallery original export', () => {
  it.each([
    ['jpg', new Uint8Array([255, 216, 255, 224])],
    ['webp', new TextEncoder().encode('RIFF0000WEBP')],
  ])('keeps %s bytes and extension without claiming PNG metadata', async (ext, bytes) => {
    vi.mocked(artworkRepository.getImage).mockResolvedValue(new Blob([bytes], { type: 'image/png' }))
    const saveImage = vi.fn().mockResolvedValue({ saved: true })
    desktopFixture.current = { saveImage } as unknown as CompanionDesktopBridge
    const { downloadCurrent, showToast } = setup()
    await downloadCurrent()
    expect(saveImage.mock.calls[0][0].name).toMatch(new RegExp(`\\.${ext}$`))
    expect(saveImage.mock.calls[0][0].data).toEqual(bytes)
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('保留原始格式'))
  })
  it('embeds PNG generation metadata including zero CFG and seed', async () => {
    vi.mocked(artworkRepository.getImage).mockResolvedValue(new Blob([png]))
    const saveImage = vi.fn().mockResolvedValue({ saved: true })
    desktopFixture.current = { saveImage } as unknown as CompanionDesktopBridge
    const { downloadCurrent } = setup()
    await downloadCurrent()
    const text = extractPngParameters(saveImage.mock.calls[0][0].data.buffer)
    expect(text).toContain('CFG scale: 0')
    expect(text).toContain('Seed: 0')
  })
  it('distinguishes native write errors from a cancelled save dialog', async () => {
    vi.mocked(artworkRepository.getImage).mockResolvedValue(new Blob([png]))
    const saveImage = vi.fn().mockResolvedValue({ saved: false, error: '磁盘已满' })
    desktopFixture.current = { saveImage } as unknown as CompanionDesktopBridge
    const { downloadCurrent, showToast } = setup()
    await downloadCurrent()
    expect(showToast).toHaveBeenCalledWith('保存失败：磁盘已满', 'warning')
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
  })
  it('reports missing originals without creating a misleading download and allows retry', async () => {
    vi.mocked(artworkRepository.getImage).mockResolvedValueOnce(null).mockResolvedValueOnce(new Blob([png]))
    const { downloadCurrent, showToast } = setup()
    await downloadCurrent()
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('原图已丢失'), 'warning')
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    await downloadCurrent()
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce()
  })
  it('does not use a new current item when an earlier download is still reading', async () => {
    let resolve!: (blob: Blob) => void
    vi.mocked(artworkRepository.getImage).mockReturnValue(new Promise(done => { resolve = done }))
    const saveImage = vi.fn().mockResolvedValue({ saved: false })
    desktopFixture.current = { saveImage } as unknown as CompanionDesktopBridge
    const { downloadCurrent, current, showToast } = setup()
    const pending = downloadCurrent()
    current.value = { id: 'other', prompt: 'Other', cfg: 1, seed: 1 }
    await downloadCurrent()
    resolve(new Blob([png]))
    await pending
    expect(artworkRepository.getImage).toHaveBeenCalledTimes(1)
    expect(extractPngParameters(saveImage.mock.calls[0][0].data.buffer)).toContain('A quiet room')
    expect(showToast).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
  })
})

const desktopFixture = vi.hoisted(() => ({ current: undefined as CompanionDesktopBridge | undefined }))
vi.mock('@/platform/desktop/capabilities', () => ({ getDesktopCapabilities: () => desktopFixture.current }))

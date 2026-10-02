import type { CompanionDesktopBridge } from '@/types/desktop'
import { effectScope, h, KeepAlive, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { artworkRepository } from '@/storage/artworkRepository'
import { useGalleryExports } from './useGalleryExports'
import { extractPngParameters } from '@/utils/pngMetadata'

vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { getImage: vi.fn() } }))
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII='), c => c.charCodeAt(0))
const scopes: ReturnType<typeof effectScope>[] = []
const unmounts: Array<() => void> = []
// Neutral 1×1 AVIF generated with sharp, also accepted by the import/storage format contract.
const avif = Uint8Array.from(atob('AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+gABAAAAAAAAAB8AAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgSACAAAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAAnbWRhdBIACgc4AAaQENBpMhIZQmMEwAA0AACQQMkcYXI8rcg='), c => c.charCodeAt(0))
function setup() {
  const current = ref({ id: 'artwork-one', prompt: 'A quiet room', cfg: 0, seed: 0 })
  const showToast = vi.fn()
  const deps = { current, stamp: () => 0, sceneTitle: () => '作品', characterName: () => '', showToast }
  const scope = effectScope()
  scopes.push(scope)
  const exports = scope.run(() => useGalleryExports(deps as unknown as Parameters<typeof useGalleryExports>[0]))!
  return { ...exports, current, showToast, scope }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(artworkRepository.getImage).mockReset()
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(() => { unmounts.splice(0).forEach(unmount => unmount()); scopes.splice(0).forEach(scope => scope.stop()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); desktopFixture.current = undefined })

describe('gallery original export', () => {
  it('does not open a save dialog for an original read completed after disposal', async () => {
    let resolve!: (blob: Blob) => void
    vi.mocked(artworkRepository.getImage).mockReturnValue(new Promise(done => { resolve = done }))
    const saveImage = vi.fn().mockResolvedValue({ saved: true })
    desktopFixture.current = { saveImage } as unknown as CompanionDesktopBridge
    const { downloadCurrent, showToast, scope } = setup()
    const pending = downloadCurrent()
    scope.stop()
    resolve(new Blob([png]))
    await pending
    expect(vi.mocked(artworkRepository.getImage).mock.calls[0][1]?.aborted).toBe(true)
    expect(saveImage).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
    await downloadCurrent()
    expect(artworkRepository.getImage).toHaveBeenCalledOnce()
  })
  it('does not start a browser fallback after a disposed native save rejects', async () => {
    vi.mocked(artworkRepository.getImage).mockResolvedValue(new Blob([png]))
    let reject!: (cause: Error) => void
    const saveImage = vi.fn(() => new Promise((_done, fail) => { reject = fail }))
    desktopFixture.current = { saveImage } as unknown as CompanionDesktopBridge
    const { downloadCurrent, showToast, scope } = setup()
    const pending = downloadCurrent()
    await vi.waitFor(() => expect(saveImage).toHaveBeenCalledOnce())
    scope.stop()
    reject(new Error('dialog disconnected'))
    await pending
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
  })
  it('releases the browser URL immediately when creating the download anchor fails', async () => {
    vi.mocked(artworkRepository.getImage).mockResolvedValue(new Blob([png]))
    vi.spyOn(document, 'createElement').mockImplementationOnce(() => { throw new Error('anchor unavailable') })
    const { downloadCurrent, showToast } = setup()
    await downloadCurrent()
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:download')
    expect(showToast).toHaveBeenCalledWith('anchor unavailable', 'warning')
  })
  it('aborts fallback source reads and rejects their late response on disposal', async () => {
    vi.mocked(artworkRepository.getImage).mockResolvedValue(null)
    let resolve!: (response: Response) => void
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(done => { resolve = done }))
    vi.stubGlobal('fetch', fetch)
    const { downloadCurrent, current, showToast, scope } = setup()
    Object.assign(current.value, { image_url: 'https://example.invalid/neutral.png' })
    const pending = downloadCurrent()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    scope.stop()
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true)
    resolve(new Response(new Blob([png])))
    await pending
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
  })
  it('cancels pending reads on KeepAlive deactivation and allows export after reactivation', async () => {
    let resolve!: (blob: Blob) => void
    vi.mocked(artworkRepository.getImage).mockReturnValueOnce(new Promise(done => { resolve = done })).mockResolvedValue(new Blob([png]))
    const active = ref(true)
    let actions!: ReturnType<typeof setup>
    const Gallery = { setup() { actions = setup(); return () => h('span') } }
    const wrapper = mount({ setup: () => () => h(KeepAlive, () => active.value ? h(Gallery) : null) })
    unmounts.push(() => wrapper.unmount())
    const pending = actions.downloadCurrent()
    active.value = false
    await nextTick()
    resolve(new Blob([png]))
    await pending
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    expect(actions.showToast).not.toHaveBeenCalled()
    await actions.downloadCurrent()
    expect(artworkRepository.getImage).toHaveBeenCalledOnce()
    active.value = true
    await nextTick()
    await actions.downloadCurrent()
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce()
  })
  it('releases successful browser downloads once after the grace period or disposal', async () => {
    vi.mocked(artworkRepository.getImage).mockResolvedValue(new Blob([png]))
    const { downloadCurrent, scope } = setup()
    await downloadCurrent()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:download')
    await downloadCurrent()
    expect(vi.getTimerCount()).toBe(1)
    scope.stop()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([
    ['jpg', new Uint8Array([255, 216, 255, 224])],
    ['webp', new TextEncoder().encode('RIFF0000WEBP')],
    ['avif', avif],
  ])('keeps %s bytes and extension without claiming PNG metadata', async (ext, bytes) => {
    vi.mocked(artworkRepository.getImage).mockResolvedValue(new Blob([bytes], { type: 'image/png' }))
    const saveImage = vi.fn().mockResolvedValue({ saved: true })
    desktopFixture.current = { saveImage } as unknown as CompanionDesktopBridge
    const { downloadCurrent, showToast } = setup()
    await downloadCurrent()
    expect(saveImage).toHaveBeenCalledOnce()
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

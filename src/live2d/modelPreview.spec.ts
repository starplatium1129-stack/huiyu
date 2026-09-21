import { beforeEach, describe, expect, it, vi } from 'vitest'
import { connectModelPreview, createModelPreviewUrls, MODEL_PREVIEW_LIMITS } from './modelPreview'
import { resolve as resolveLegacyUrl } from 'node:url'
import type { Live2DModelHandle, Live2DStageSession } from './types'
import type { ModelInspection } from './modelInspector'
const connect = vi.hoisted(() => vi.fn())
vi.mock('./browserBackend', () => ({ createBrowserLive2DBackend: () => ({ connect }) }))
function sessionFixture() {
  let loaded!: (model: Live2DModelHandle) => void, failed!: (error: Error) => void
  const session = { destroy: vi.fn(), setMaxFps: vi.fn(), onModelLoaded: (callback: typeof loaded) => { loaded = callback }, onModelError: (callback: typeof failed) => { failed = callback } } as unknown as Live2DStageSession
  return { session, loaded: (model: Live2DModelHandle) => loaded(model), failed: (error: Error) => failed(error) }
}
beforeEach(() => { connect.mockReset() })
describe('isolated preview lifecycle', () => {
  it('destroys a late connection and never exposes it after cancellation', async () => {
    let finish!: (session: Live2DStageSession) => void
    connect.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const abort = new AbortController(), loaded = vi.fn(), fixture = sessionFixture()
    const pending = connectModelPreview('#fixture', 'blob:model', abort.signal, loaded, vi.fn())
    abort.abort(); finish(fixture.session)
    await expect(pending).rejects.toThrow('取消')
    expect(fixture.session.destroy).toHaveBeenCalledOnce()
    expect(loaded).not.toHaveBeenCalled()
  })
  it('releases active sessions exactly once and ignores late events', async () => {
    const fixture = sessionFixture(), abort = new AbortController(), loaded = vi.fn(), failed = vi.fn()
    connect.mockResolvedValue(fixture.session)
    const session = await connectModelPreview('#fixture', 'blob:model', abort.signal, loaded, failed)
    abort.abort(); session.destroy()
    fixture.loaded({} as Live2DModelHandle); fixture.failed(new Error('late'))
    expect(fixture.session.destroy).toHaveBeenCalledOnce()
    expect(loaded).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled()
  })
  it('fails closed and releases resources when model dimensions or initialization fail', async () => {
    const fixture = sessionFixture(), failed = vi.fn()
    connect.mockResolvedValue(fixture.session)
    await connectModelPreview('#fixture', 'blob:model', new AbortController().signal, vi.fn(), failed)
    fixture.loaded({ getNaturalSize: () => ({ width: NaN, height: 1 }) } as Live2DModelHandle)
    expect(failed).toHaveBeenCalledOnce(); expect(fixture.session.destroy).toHaveBeenCalledOnce()
  })
  it('fits the actual narrow host and disconnects resize observation on release', async () => {
    const host = document.createElement('div'); host.id = 'narrow-preview'; document.body.append(host)
    Object.defineProperties(host, { clientWidth: { value: 280, configurable: true }, clientHeight: { value: 320, configurable: true } })
    let resize = () => {}
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback } observe() {} disconnect = disconnect })
    try {
      const fixture = sessionFixture(), applyFit = vi.fn(), resizeCanvas = vi.fn()
      fixture.session.resizeCanvas = resizeCanvas
      connect.mockResolvedValue(fixture.session)
      const session = await connectModelPreview('#narrow-preview', 'blob:model', new AbortController().signal, vi.fn(), vi.fn())
      expect(connect).toHaveBeenCalledWith(expect.objectContaining({ canvasWidth: 280, canvasHeight: 320 }))
      fixture.loaded({ getNaturalSize: () => ({ width: 400, height: 600 }), applyFit } as unknown as Live2DModelHandle)
      expect(applyFit).toHaveBeenLastCalledWith(280 / 600, (280 - 400 * 280 / 600) / 2, 20)
      Object.defineProperty(host, 'clientWidth', { value: 500 }); resize()
      expect(resizeCanvas).toHaveBeenLastCalledWith(500, 320)
      expect(applyFit).toHaveBeenLastCalledWith(280 / 600, (500 - 400 * 280 / 600) / 2, 20)
      session.destroy(); expect(disconnect).toHaveBeenCalledOnce()
      applyFit.mockClear(); resize(); expect(applyFit).not.toHaveBeenCalled()
    } finally { host.remove(); vi.unstubAllGlobals() }
  })
  it('rejects corrupted references without creating URLs', async () => {
    const create = vi.spyOn(URL, 'createObjectURL')
    const inspection = { valid: true, entryPath: 'demo.model3.json', entries: [{ path: 'demo.model3.json', file: new File(['{}'], 'demo.model3.json') }], modelJson: { FileReferences: { Moc: '../escape.moc3', Textures: [] } } } as unknown as ModelInspection
    await expect(createModelPreviewUrls(inspection)).rejects.toThrow()
    expect(create).not.toHaveBeenCalled()
  })
  it('owns exactly one manifest URL, uses safe data dependencies, and revokes it on early abort', async () => {
    const paths = ['nested/main.MODEL3.JSON', 'nested/core.moc3', 'nested/textures/image.png', 'nested/tap.motion3.json']
    const inspection = { valid: true, entryPath: paths[0], entries: paths.map(path => ({ path, file: new File(['fixture'], path.split('/').at(-1)!) })),
      modelJson: { Version: 3, FileReferences: { Moc: 'core.moc3', Textures: ['textures/image.png'], Motions: { Tap: [{ File: 'tap.motion3.json', Sound: 'sound.wav' }] } } } } as unknown as ModelInspection
    let manifest!: Blob
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { manifest = blob as Blob; return 'blob:http://127.0.0.1:8888/owned' })
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const controller = new AbortController()
    const prepared = await createModelPreviewUrls(inspection, controller.signal)
    const refs = JSON.parse(await manifest.text()).FileReferences
    expect(refs.Moc).toBe('data:application/octet-stream;base64,Zml4dHVyZQ==')
    expect(refs.Textures[0]).toBe('data:image/png;base64,Zml4dHVyZQ==')
    expect(refs.Motions.Tap[0].Sound).toBeUndefined()
    // The installed SDK uses this legacy resolver; blob:http:// used to lose its colon.
    expect(resolveLegacyUrl(prepared.modelUrl, refs.Moc)).toBe(refs.Moc)
    expect(resolveLegacyUrl(prepared.modelUrl, refs.Textures[0])).toBe(refs.Textures[0])
    expect(create).toHaveBeenCalledOnce()
    controller.abort(); prepared.release()
    expect(revoke).toHaveBeenCalledExactlyOnceWith(prepared.modelUrl)
  })
  it('rejects oversized encoded dependencies and already-cancelled preparation before allocating URLs', async () => {
    const core = new File(['MOC3'], 'core.moc3')
    Object.defineProperty(core, 'size', { value: MODEL_PREVIEW_LIMITS.dependencyBytes + 1 })
    const inspection = { valid: true, entryPath: 'main.model3.json', entries: [{ path: 'main.model3.json', file: new File(['{}'], 'main.model3.json') }, { path: 'core.moc3', file: core }],
      modelJson: { FileReferences: { Moc: 'core.moc3', Textures: [] } } } as unknown as ModelInspection
    const create = vi.spyOn(URL, 'createObjectURL')
    await expect(createModelPreviewUrls(inspection)).rejects.toThrow('限制')
    const cancelled = new AbortController(); cancelled.abort()
    await expect(createModelPreviewUrls(inspection, cancelled.signal)).rejects.toThrow()
    expect(create).not.toHaveBeenCalled()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLive2DCtx } from './live2d/context'
import { createLifecycleController } from './live2d/lifecycle'
import { BROWSER_CAPABILITY, type Live2DConnectOptions, type Live2DModelHandle, type Live2DStageSession } from '@/live2d/types'
import { NATIVE_RENDER_STOPPED } from '@/live2d/nativeBackend'
import { mediaStatusApi } from '@/api/mediaStatusApi'
import * as runtime from '@/platform/desktop/runtime'
import * as backendFactory from '@/live2d/createBackend'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function setup() {
  vi.useFakeTimers()
  const ctx = createLive2DCtx()
  ctx.enabled.value = true
  ctx.catalog = { models: { nene: { available: true, modelUrl: '/nene.model3.json', source: '', missing: [] } } }
  ctx.hostEl = document.createElement('div')
  ctx.stageEl = document.createElement('div')
  let loaded!: (model: Live2DModelHandle) => void
  let failed!: (error: Error) => void
  const model: Live2DModelHandle = {
    visible: true, motion: vi.fn(() => false), expression: vi.fn(() => true),
    hitTest: () => [], focus: vi.fn(), setParameterValueById: vi.fn(),
    onBeforeModelUpdate: vi.fn(), applyFit: vi.fn(), getNaturalSize: () => ({ width: 420, height: 610 }),
  }
  const session: Live2DStageSession = {
    kind: 'browser', capability: BROWSER_CAPABILITY,
    onModelLoaded: callback => { loaded = callback }, onModelError: callback => { failed = callback },
    setPaused: vi.fn(), setMaxFps: vi.fn(), getScreenSize: model.getNaturalSize,
    getCanvasSize: model.getNaturalSize, setStageScale: vi.fn(), canvasElement: () => null, destroy: vi.fn(),
  }
  const connect = vi.fn<(options: Live2DConnectOptions) => Promise<Live2DStageSession>>(async () => session)
  ctx.backend = { kind: 'browser', capability: BROWSER_CAPABILITY, connect }
  const setState = vi.fn()
  const lifecycle = createLifecycleController(ctx, {
    pointerGaze: { bind: vi.fn() }, emotionClock: { start: vi.fn(), stop: vi.fn() },
    layoutFit: { fit: vi.fn(), layout: vi.fn(), scheduleNativeLayout: vi.fn(), resetWindowBounds: vi.fn() },
    interactions: { bind: vi.fn(), stopAudio: vi.fn() }, parameterFrame: { bindMouthOverride: vi.fn() },
  }, { setState })
  return { ctx, lifecycle, connect, session, model, setState, loaded: () => loaded(model), failed: (e: Error) => failed(e) }
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('Live2D lifecycle races', () => {
  it('recovers the missing startup catalog once the runtime is ready, respecting hidden and disabled stages', async () => {
    const h = setup()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const unsubscribe = vi.fn()
    let changed!: (value: runtime.DesktopConnectionState) => void
    vi.spyOn(runtime, 'onDesktopRuntime').mockImplementation(listener => { changed = listener; return unsubscribe })
    vi.spyOn(runtime, 'getDesktopRuntime').mockReturnValue({ connection: 'starting', bootstrap: null })
    vi.spyOn(backendFactory, 'selectLive2DBackend').mockReturnValue({ backend: h.ctx.backend!, effectiveKind: 'browser', fallbackReason: null })
    const fetchCatalog = vi.spyOn(mediaStatusApi, 'getLive2DStatus')
      .mockRejectedValueOnce(new Error('本地运行时尚未连接'))
      .mockResolvedValue({ models: { nene: { available: true, modelUrl: '/nene.model3.json' } } } as Awaited<ReturnType<typeof mediaStatusApi.getLive2DStatus>>)
    await h.lifecycle.init('nene', h.ctx.hostEl!, h.ctx.stageEl!, { autoLoad: true })
    expect(h.ctx.enabled.value).toBe(true)
    expect(h.setState).toHaveBeenLastCalledWith('fallback', 'Live2D 未就绪', '本地运行时尚未连接', true)
    h.lifecycle.setPaused(true)
    changed({ connection: 'ready', bootstrap: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchCatalog).toHaveBeenCalledOnce()
    expect(h.connect).not.toHaveBeenCalled()
    h.lifecycle.setPaused(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchCatalog).toHaveBeenCalledTimes(2)
    expect(h.connect).toHaveBeenCalledOnce()
    h.loaded()
    changed({ connection: 'ready', bootstrap: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.ctx.ready.value).toBe(true)
    expect(h.connect).toHaveBeenCalledOnce()
    h.lifecycle.disable()
    h.ctx.catalog = null
    changed({ connection: 'unavailable', bootstrap: null })
    changed({ connection: 'ready', bootstrap: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchCatalog).toHaveBeenCalledTimes(2)
    h.lifecycle.destroy()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('loads a catalog checked while hidden when the desktop becomes visible', async () => {
    const h = setup()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    vi.spyOn(backendFactory, 'selectLive2DBackend').mockReturnValue({ backend: h.ctx.backend!, effectiveKind: 'browser', fallbackReason: null })
    vi.spyOn(mediaStatusApi, 'getLive2DStatus').mockResolvedValue({ models: { nene: { available: true, modelUrl: '/nene.model3.json' } } } as Awaited<ReturnType<typeof mediaStatusApi.getLive2DStatus>>)
    h.lifecycle.setPaused(true)
    await h.lifecycle.init('nene', h.ctx.hostEl!, h.ctx.stageEl!, { autoLoad: true })
    expect(h.connect).not.toHaveBeenCalled()
    h.lifecycle.setPaused(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.connect).toHaveBeenCalledOnce()
    h.loaded()
    h.lifecycle.destroy()
  })

  it('quality changes cancel an obsolete load and keep the latest profile', async () => {
    const h = setup()
    const connection = deferred<Live2DStageSession>()
    h.connect.mockReturnValueOnce(connection.promise)
    const original = h.lifecycle.setCharacter('nene')
    const standard = h.lifecycle.setQuality('standard')
    const compact = h.lifecycle.setQuality('compact')
    await Promise.resolve()
    const old = { ...h.session, destroy: vi.fn() }
    connection.resolve(old)
    await Promise.resolve()
    h.loaded()
    await Promise.all([original, standard, compact])
    expect(h.connect.mock.calls[0]![0].signal!.aborted).toBe(true)
    expect(h.connect).toHaveBeenLastCalledWith(expect.objectContaining({ modelUrl: '/api/live2d-model/nene/compact', textureScale: 4 }))
    expect(old.destroy).toHaveBeenCalledOnce()
    expect(h.ctx.quality.value).toBe('compact')
    expect(h.ctx.ready.value).toBe(true)
    h.lifecycle.destroy()
  })

  it('applies the requested FPS as soon as a single-outfit model is ready', async () => {
    const h = setup()
    h.ctx.catalog!.models.natsume = { available: true, modelUrl: '/natsume.model3.json', source: '', missing: [] }
    h.ctx.maxFps = 30
    const loading = h.lifecycle.setCharacter('natsume')
    await Promise.resolve()
    h.loaded()
    await loading
    expect(h.session.setMaxFps).toHaveBeenCalledWith(30)
    expect(h.model.expression).not.toHaveBeenCalled()
    h.lifecycle.destroy()
  })

  it('a hidden desktop stays paused after loading, speech wakeups and recovery', async () => {
    const h = setup()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    h.lifecycle.setPaused(true)
    const loading = h.lifecycle.setCharacter('nene')
    await Promise.resolve()
    h.loaded()
    await loading
    h.lifecycle.resumeRendering()
    await h.lifecycle.recover()
    expect(h.session.setPaused).toHaveBeenLastCalledWith(true)
    h.lifecycle.setPaused(false)
    expect(h.session.setPaused).toHaveBeenLastCalledWith(false)
    h.lifecycle.destroy()
  })

  it('a hanging connect times out, and its late result cannot clear a retry', async () => {
    const h = setup()
    const connection = deferred<Live2DStageSession>()
    h.connect.mockReturnValueOnce(connection.promise)
    const loading = h.lifecycle.setCharacter('nene')
    const signal = h.connect.mock.calls[0]![0].signal
    await vi.advanceTimersByTimeAsync(20000)
    await loading
    expect(signal?.aborted).toBe(true)
    expect(h.ctx.loading).toBeNull()
    expect(h.setState).toHaveBeenLastCalledWith('fallback', 'Live2D 加载超时', expect.any(String), true)
    const retrying = h.lifecycle.retry()
    await Promise.resolve()
    const pendingRetry = h.ctx.loading
    const stale = { ...h.session, destroy: vi.fn() }
    connection.resolve(stale)
    await Promise.resolve()
    expect(stale.destroy).toHaveBeenCalledOnce()
    expect(h.ctx.loading).toBe(pendingRetry)
    h.loaded()
    await retrying
    expect(h.ctx.ready.value).toBe(true)
    h.lifecycle.destroy()
  })

  it('destroy settles a connection that never answers', async () => {
    const h = setup()
    h.connect.mockReturnValueOnce(new Promise(() => {}))
    const loading = h.lifecycle.setCharacter('nene')
    h.lifecycle.destroy()
    await loading
    expect(h.connect.mock.calls[0]![0].signal?.aborted).toBe(true)
    expect(h.ctx.loading).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('disabling during connect destroys the late session without making it visible', async () => {
    const h = setup()
    const connection = deferred<Live2DStageSession>()
    h.connect.mockReturnValueOnce(connection.promise)
    const loading = h.lifecycle.setCharacter('nene')
    h.lifecycle.disable()
    await Promise.resolve()
    connection.resolve(h.session)
    await loading
    expect(h.session.destroy).toHaveBeenCalledOnce()
    expect(h.ctx.session).toBeNull()
    expect(h.ctx.ready.value).toBe(false)
  })

  it('destroy settles model loading and ignores late success and error callbacks', async () => {
    const h = setup()
    const loading = h.lifecycle.setCharacter('nene')
    await Promise.resolve()
    h.lifecycle.destroy()
    await loading
    h.loaded()
    h.failed(new Error('late error'))
    expect(h.ctx.loading).toBeNull()
    expect(h.ctx.ready.value).toBe(false)
    expect(h.setState).toHaveBeenLastCalledWith('loading', 'Live2D 加载中…')
  })

  it('a stopped renderer releases stale readiness and reconnects after backoff', async () => {
    const h = setup()
    const loading = h.lifecycle.setCharacter('nene')
    await Promise.resolve()
    h.loaded()
    await loading
    const stopped = new Error('device lost')
    stopped.name = NATIVE_RENDER_STOPPED
    h.failed(stopped)
    expect(h.ctx.ready.value).toBe(false)
    expect(h.session.destroy).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1200)
    expect(h.connect).toHaveBeenCalledTimes(2)
    h.loaded()
    expect(h.ctx.ready.value).toBe(true)
    h.lifecycle.destroy()
  })

  it('disable cancels a queued renderer recovery', async () => {
    const h = setup()
    const loading = h.lifecycle.setCharacter('nene')
    await Promise.resolve()
    h.loaded()
    await loading
    h.failed(Object.assign(new Error('stopped'), { name: NATIVE_RENDER_STOPPED }))
    h.lifecycle.disable()
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.connect).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('switching to a static character releases the old renderer', async () => {
    const h = setup()
    const loading = h.lifecycle.setCharacter('nene')
    await Promise.resolve()
    h.loaded()
    await loading
    await h.lifecycle.setCharacter('static-only')
    expect(h.session.destroy).toHaveBeenCalledOnce()
    expect(h.ctx.ready.value).toBe(false)
    expect(h.ctx.loadedCharacter.value).toBe('')
  })

  it('a timed-out session cannot revive through a late ready event', async () => {
    const h = setup()
    const loading = h.lifecycle.setCharacter('nene')
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(20000)
    await loading
    h.loaded()
    expect(h.ctx.ready.value).toBe(false)
    expect(h.session.destroy).toHaveBeenCalledOnce()
    expect(h.setState).toHaveBeenLastCalledWith('fallback', 'Live2D 加载超时', expect.any(String), true)
  })

  it('unmount during catalog lookup does not attach observers or load a model', async () => {
    const h = setup()
    const catalog = deferred<Awaited<ReturnType<typeof mediaStatusApi.getLive2DStatus>>>()
    vi.spyOn(mediaStatusApi, 'getLive2DStatus').mockReturnValueOnce(catalog.promise)
    const init = h.lifecycle.init('nene', h.ctx.hostEl!, h.ctx.stageEl!, { autoLoad: true })
    h.lifecycle.destroy()
    catalog.resolve({ models: {} } as Awaited<ReturnType<typeof mediaStatusApi.getLive2DStatus>>)
    await init
    expect(h.ctx.resizeObserver).toBeNull()
    expect(h.ctx.visibilityHandler).toBeNull()
    expect(h.connect).not.toHaveBeenCalled()
  })
})

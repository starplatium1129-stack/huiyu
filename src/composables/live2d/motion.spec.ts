import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLive2DCtx } from './context'
import { createLifecycleController } from './lifecycle'
import { mediaStatusApi } from '@/api/mediaStatusApi'
import { BROWSER_CAPABILITY, type Live2DStageSession } from '@/live2d/types'

afterEach(() => { delete document.documentElement.dataset.motion; vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('009 Live2D motion preference ownership (mock session)', () => {
  it('settles and resumes the same session over 20 preference cycles without loading a model', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    vi.spyOn(mediaStatusApi, 'getLive2DStatus').mockResolvedValue({ models: {} } as Awaited<ReturnType<typeof mediaStatusApi.getLive2DStatus>>)
    const ctx = createLive2DCtx()
    const start = vi.fn(), stop = vi.fn()
    const lifecycle = createLifecycleController(ctx, {
      pointerGaze: { bind: vi.fn() }, emotionClock: { start, stop },
      layoutFit: { fit: vi.fn(), layout: vi.fn(), scheduleNativeLayout: vi.fn(), resetWindowBounds: vi.fn() },
      interactions: { bind: vi.fn(), stopAudio: vi.fn() }, parameterFrame: { bindMouthOverride: vi.fn() },
    }, { setState: vi.fn() })
    await lifecycle.init('nene', document.createElement('div'), document.createElement('div'), { autoLoad: false })
    const session: Live2DStageSession = {
      kind: 'browser', capability: BROWSER_CAPABILITY,
      onModelLoaded: vi.fn(), onModelError: vi.fn(), setPaused: vi.fn(), setMaxFps: vi.fn(),
      getScreenSize: () => ({ width: 420, height: 610 }), getCanvasSize: () => ({ width: 420, height: 610 }),
      setStageScale: vi.fn(), canvasElement: () => null, destroy: vi.fn(),
    }
    ctx.session = session
    try {
      for (let i = 0; i < 20; i++) {
        document.documentElement.dataset.motion = 'reduce'
        window.dispatchEvent(new Event('atelier:motion-preference'))
        expect(session.setPaused).toHaveBeenLastCalledWith(true)
        document.documentElement.dataset.motion = 'full'
        window.dispatchEvent(new Event('atelier:motion-preference'))
        expect(session.setPaused).toHaveBeenLastCalledWith(false)
      }
      expect(ctx.session).toBe(session); expect(ctx.model).toBeNull(); expect(session.destroy).not.toHaveBeenCalled()
      expect(start).toHaveBeenCalledTimes(20)
      lifecycle.destroy()
      const calls = vi.mocked(session.setPaused).mock.calls.length
      window.dispatchEvent(new Event('atelier:motion-preference'))
      expect(session.setPaused).toHaveBeenCalledTimes(calls)
    } finally { lifecycle.destroy() }
  })
})

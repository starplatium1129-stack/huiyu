import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLive2DCtx } from './context'
import { createPointerGazeController } from './pointerGaze'
import type { Live2DModelHandle } from '@/live2d/types'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function setup() {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const frames = new Map<number, FrameRequestCallback>()
  let next = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++next, callback); return next })
  const ctx = createLive2DCtx()
  ctx.ready.value = true
  ctx.model = { focus: vi.fn() } as unknown as Live2DModelHandle
  ctx.stageEl = document.createElement('div')
  const measure = vi.spyOn(ctx.stageEl, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 100 } as DOMRect)
  const controller = createPointerGazeController(ctx)
  controller.bind()
  return {
    ctx, controller, measure, frames,
    move(x: number, y: number) { ctx.stageEl!.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y })) },
    frame() {
      const callbacks = [...frames.values()]
      frames.clear()
      for (const callback of callbacks) callback(performance.now() + 16)
    },
  }
}

describe('pointer gaze frame coalescing', () => {
  it('measures once for 100 pointer events and follows the latest position', () => {
    const s = setup()
    for (let i = 0; i < 100; i++) s.move(i, 25)
    expect(s.measure).not.toHaveBeenCalled()
    expect(s.frames.size).toBe(1)
    s.frame()
    expect(s.measure).toHaveBeenCalledTimes(1)
    expect(s.ctx.gaze.x).toBeCloseTo(0.98)
    expect(s.ctx.gaze.y).toBe(0.5)
    s.frame()
    expect(s.measure).toHaveBeenCalledTimes(1)
    expect(s.ctx.model!.focus).toHaveBeenCalledTimes(2)
  })

  it('uses the current layout and preserves desktop coordinate conversion and clamp', () => {
    const s = setup()
    s.move(0, 0)
    s.controller.setGlobalPointer(400, 250, { x: 100, y: 200, width: 100, height: 100 })
    s.measure.mockReturnValue({ left: 0, top: 0, width: 100, height: 200 } as DOMRect)
    s.frame()
    expect(s.measure).toHaveBeenCalledTimes(1)
    expect(s.ctx.gaze.x).toBe(0.82)
    expect(s.ctx.gaze.y).toBe(0.5)
    expect(s.ctx.gaze.kind).toBe('global')
  })

  it('mouseleave discards queued movement before returning to center', () => {
    const s = setup()
    s.move(100, 100)
    s.ctx.stageEl!.dispatchEvent(new MouseEvent('mouseleave'))
    s.frame()
    expect(s.measure).not.toHaveBeenCalled()
    expect(s.ctx.gaze.active).toBe(false)
    expect(s.ctx.gaze.x).toBe(0)
    expect(s.ctx.gaze.y).toBe(0)
    expect(s.frames.size).toBe(0)
  })

  it('does not measure queued events after hiding or replacing the session', () => {
    const s = setup()
    s.move(100, 100)
    s.ctx.desktopVisible = false
    s.frame()
    expect(s.measure).not.toHaveBeenCalled()
    expect(s.frames.size).toBe(0)
    s.ctx.desktopVisible = true
    s.move(100, 100)
    s.ctx.lifecycleToken++
    s.frame()
    expect(s.measure).not.toHaveBeenCalled()
    expect(s.ctx.gaze.active).toBe(false)
  })
})

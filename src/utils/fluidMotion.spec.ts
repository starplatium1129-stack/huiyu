import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFluidMotion } from './fluidSpring'

const preference = vi.hoisted(() => ({ reduced: false }))
vi.mock('./motionPreference', () => ({ prefersReducedMotion: () => preference.reduced }))
let frames: Map<number, FrameRequestCallback>, nextId: number, now: number
let media: EventTarget
let disposers: Array<() => void>
function step() {
  now += 1000 / 60
  const pending = [...frames.values()]; frames.clear()
  pending.forEach(callback => callback(now))
}
function drain() { for (let i = 0; i < 180 && frames.size; i++) step(); expect(frames.size).toBe(0) }
function create(write = vi.fn()) {
  const motion = createFluidMotion([0], write)
  disposers.push(motion.dispose)
  return { motion, write }
}
beforeEach(() => {
  frames = new Map(); nextId = 0; now = 0; disposers = []; media = new EventTarget(); preference.reduced = false
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = nextId++; frames.set(id, cb); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('matchMedia', () => media)
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
})
afterEach(() => { disposers.forEach(dispose => dispose()); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('009 surface frame lifecycle', () => {
  it('runs one loop even when frame id is zero and completes exactly once', () => {
    const { motion, write } = create(), done = vi.fn()
    motion.to([1], false, done); motion.to([1], false, done)
    expect(frames.size).toBe(1); drain()
    expect(write).toHaveBeenLastCalledWith([1]); expect(done).toHaveBeenCalledTimes(1)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(done).toHaveBeenCalledTimes(1)
  })
  it('retargets without snapping position or running a stale completion', () => {
    const { motion, write } = create(), first = vi.fn(), last = vi.fn()
    motion.to([1], false, first); step(); step()
    const position = write.mock.calls.at(-1)![0][0]
    motion.to([0], false, last)
    expect(write.mock.calls.at(-1)![0][0]).toBe(position)
    expect(frames.size).toBe(1); drain()
    expect(first).not.toHaveBeenCalled(); expect(last).toHaveBeenCalledTimes(1)
  })
  it('settles immediately when reduced motion changes during an animation', () => {
    const { motion, write } = create(), done = vi.fn()
    motion.to([1], false, done); step(); preference.reduced = true
    window.dispatchEvent(new Event('atelier:motion-preference'))
    expect(frames.size).toBe(0); expect(write).toHaveBeenLastCalledWith([1]); expect(done).toHaveBeenCalledTimes(1)
  })
  it('settles on the system preference event', () => {
    const { motion } = create(), done = vi.fn()
    motion.to([1], false, done); preference.reduced = true; media.dispatchEvent(new Event('change'))
    expect(done).toHaveBeenCalledTimes(1); expect(frames.size).toBe(0)
  })
  it('settles when hidden and never replays a completed surface on resume', () => {
    const { motion, write } = create(), done = vi.fn()
    motion.to([1], false, done); step()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    const writes = write.mock.calls.length
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(write).toHaveBeenCalledTimes(writes); expect(done).toHaveBeenCalledTimes(1); expect(frames.size).toBe(0)
  })
  it('does not rewrite presentation styles at rest when a preference changes', () => {
    const { motion, write } = create()
    motion.to([1], true); const count = write.mock.calls.length
    preference.reduced = true; window.dispatchEvent(new Event('atelier:motion-preference'))
    expect(write).toHaveBeenCalledTimes(count)
  })
  it('supports absent matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined)
    const { motion } = create(), done = vi.fn()
    motion.to([1], true, done); expect(done).toHaveBeenCalledTimes(1)
  })
  it('supports and removes legacy media listeners', () => {
    const addListener = vi.fn(), removeListener = vi.fn()
    vi.stubGlobal('matchMedia', () => ({ addListener, removeListener }))
    const { motion } = create(); motion.dispose(); motion.dispose()
    expect(addListener).toHaveBeenCalledTimes(1)
    expect(removeListener).toHaveBeenCalledWith(addListener.mock.calls[0][0]); expect(removeListener).toHaveBeenCalledTimes(1)
  })
  it('falls back when requestAnimationFrame is missing or throws', () => {
    for (const raf of [undefined, () => { throw new Error('unavailable') }]) {
      vi.stubGlobal('requestAnimationFrame', raf)
      const { motion, write } = create(), done = vi.fn()
      motion.to([1], false, done)
      expect(write).toHaveBeenLastCalledWith([1]); expect(done).toHaveBeenCalledTimes(1)
    }
  })
  it('supports explicit lifecycle settlement without removing its listeners', () => {
    const { motion } = create(), done = vi.fn()
    motion.to([1], false, done); motion.settle(); motion.settle()
    expect(done).toHaveBeenCalledTimes(1)
    motion.to([0], false, done); drain(); expect(done).toHaveBeenCalledTimes(2)
  })
  it('disposal is terminal and removes callbacks, frames and listeners', () => {
    const remove = vi.spyOn(window, 'removeEventListener'), { motion, write } = create(), done = vi.fn()
    motion.to([1], false, done); motion.dispose(); const writes = write.mock.calls.length
    motion.to([0], false, done); motion.settle(); preference.reduced = true
    window.dispatchEvent(new Event('atelier:motion-preference'))
    expect(frames.size).toBe(0); expect(done).not.toHaveBeenCalled(); expect(write).toHaveBeenCalledTimes(writes)
    expect(remove.mock.calls.some(([event]) => event === 'atelier:motion-preference')).toBe(true)
  })
  it('does not resurrect a loop disposed during a frame write', () => {
    const write = vi.fn(), { motion } = create(write)
    motion.to([1]); write.mockImplementation(() => motion.dispose()); step()
    expect(frames.size).toBe(0)
  })
  it('allows a completion to start a new independent motion', () => {
    const { motion } = create(), done = vi.fn(() => motion.to([0]))
    motion.to([1], false, done); drain()
    expect(done).toHaveBeenCalledTimes(1)
  })
})

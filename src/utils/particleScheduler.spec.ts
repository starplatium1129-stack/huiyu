import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerParticleFrame } from './particleScheduler'
let frames: Map<number, FrameRequestCallback>, nextId: number
let disposers: Array<() => void>
function tick(now: number) { const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb(now)) }
function register(cb = vi.fn(), fps = 30) { const dispose = registerParticleFrame(cb, fps); disposers.push(dispose); return { cb, dispose } }
beforeEach(() => {
  frames = new Map(); nextId = 0; disposers = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = nextId++; frames.set(id, cb); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
})
afterEach(() => { disposers.forEach(dispose => dispose()); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('009 shared particle scheduler', () => {
  it('shares one loop even with frame id zero and preserves requested cadence', () => {
    const a = register(vi.fn(), 30), b = register(vi.fn(), 0)
    expect(frames.size).toBe(1)
    tick(0); tick(16.7); tick(33.4)
    expect(a.cb).toHaveBeenCalledTimes(2); expect(b.cb).toHaveBeenCalledTimes(3)
    a.dispose(); expect(frames.size).toBe(1); b.dispose(); expect(frames.size).toBe(0)
  })
  it('cancels immediately while hidden and resumes once without a backlog', () => {
    const { cb } = register(); tick(0)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange')); expect(frames.size).toBe(0)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange')); document.dispatchEvent(new Event('visibilitychange'))
    expect(frames.size).toBe(1); tick(60000)
    expect(cb).toHaveBeenCalledTimes(2)
  })
  it('does not start work for a hidden document', () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    register(); expect(frames.size).toBe(0)
  })
  it('does not run a newly registered layer in the current frame', () => {
    let created = false
    const next = vi.fn()
    register(vi.fn(() => { if (!created) { created = true; register(next) } }))
    tick(0); expect(next).not.toHaveBeenCalled(); tick(40); expect(next).toHaveBeenCalledTimes(1)
  })
  it('skips a subscriber removed by an earlier subscriber in the same frame', () => {
    let remove = () => {}
    register(vi.fn(() => remove()))
    const b = register(); remove = b.dispose
    tick(0); expect(b.cb).not.toHaveBeenCalled()
  })
  it('balances listener ownership and leaves no frame after 20 mount/hide/resume/dispose cycles', () => {
    const add = vi.spyOn(document, 'addEventListener'), remove = vi.spyOn(document, 'removeEventListener')
    for (let round = 0; round < 20; round++) {
      const a = register(), b = register(); tick(round * 1000)
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
      document.dispatchEvent(new Event('visibilitychange')); expect(frames.size).toBe(0)
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
      document.dispatchEvent(new Event('visibilitychange')); expect(frames.size).toBe(1)
      a.dispose(); b.dispose(); b.dispose(); expect(frames.size).toBe(0)
    }
    expect(add.mock.calls.filter(([event]) => event === 'visibilitychange')).toHaveLength(20)
    expect(remove.mock.calls.filter(([event]) => event === 'visibilitychange')).toHaveLength(20)
  })
})

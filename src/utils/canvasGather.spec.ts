import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startCanvasGather } from './canvasGather'

const frames = new Map<number, FrameRequestCallback>()
const contexts: Array<ReturnType<typeof makeContext>> = []
let stop: (() => void) | null
function makeContext(canvas: HTMLCanvasElement) {
  return { canvas, globalAlpha: 1, fillStyle: '', setTransform: vi.fn(), drawImage: vi.fn(),
    fillRect: vi.fn(), clearRect: vi.fn(), getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) })) }
}
function fixture() {
  const image = document.createElement('img'), host = document.createElement('div')
  Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 3840 }, naturalHeight: { value: 2160 } })
  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 3840, 2160))
  host.appendChild(image)
  return { image, host }
}
function tick(now: number) { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(now)) }
beforeEach(() => {
  stop = null
  let id = 0
  vi.stubGlobal('devicePixelRatio', 3)
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++id, fn); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.spyOn(performance, 'now').mockReturnValue(0)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    const context = makeContext(this); contexts.push(context); return context as unknown as CanvasRenderingContext2D
  })
})
afterEach(() => { stop?.(); contexts.length = 0; frames.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('bounds 4K/DPI sampling and paints, and releases buffers on completion', () => {
  const { image, host } = fixture()
  stop = startCanvasGather(image, host, 740)
  const [overlay, sample] = contexts
  expect(overlay.canvas.width * overlay.canvas.height).toBeLessThanOrEqual(1_000_000)
  expect(sample.getImageData).toHaveBeenCalledOnce()
  const [, , width, height] = sample.getImageData.mock.calls[0]
  expect(width * height).toBeLessThanOrEqual(1200)
  expect(sample.canvas.width).toBe(0)
  tick(100)
  const paints = overlay.fillRect.mock.calls.length
  expect(paints).toBeGreaterThan(0)
  expect(paints).toBeLessThanOrEqual(1200)
  tick(101)
  expect(overlay.fillRect).toHaveBeenCalledTimes(paints)
  tick(740)
  expect(host.querySelector('canvas')).toBeNull()
  expect(overlay.canvas.width).toBe(0)
  expect(frames.size).toBe(0)
  expect(image.style.transform).toBe('')
})

it('cancels idempotently even if a queued callback is already dispatched', () => {
  const { image, host } = fixture()
  stop = startCanvasGather(image, host, 740)
  const stale = [...frames.values()][0]
  stop?.(); stop?.(); stale(100)
  expect(frames.size).toBe(0)
  expect(host.querySelector('canvas')).toBeNull()
  expect(contexts[0].fillRect).not.toHaveBeenCalled()
})

it('falls back without leaking when cross-origin sampling is blocked', () => {
  const { image, host } = fixture()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    const context = makeContext(this)
    contexts.push(context)
    context.getImageData.mockImplementation(() => { throw new DOMException('Tainted canvas', 'SecurityError') })
    return context as unknown as CanvasRenderingContext2D
  })
  expect(startCanvasGather(image, host, 740)).toBeNull()
  expect(host.querySelector('canvas')).toBeNull()
  expect(frames.size).toBe(0)
  expect(contexts.every(({ canvas }) => canvas.width === 0)).toBe(true)
})

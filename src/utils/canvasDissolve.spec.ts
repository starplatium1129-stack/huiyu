import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startCanvasDissolve } from './canvasDissolve'

function makeContext(canvas: HTMLCanvasElement) {
  return {
    canvas, globalAlpha: 1, fillStyle: '',
    drawImage: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), setTransform: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4).fill(255),
    })),
  }
}
type Context = ReturnType<typeof makeContext>
let contexts: Context[]
let frames: Map<number, FrameRequestCallback>
let nextFrame: number
let stop: (() => void) | null

function tick(now: number): void {
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach(callback => callback(now))
}

function fixture(width = 800, height = 600, naturalWidth = 1600, naturalHeight = 1200) {
  const image = document.createElement('img'), host = document.createElement('div')
  image.src = 'blob:already-decoded-image'
  Object.defineProperties(image, {
    complete: { configurable: true, value: true },
    naturalWidth: { configurable: true, value: naturalWidth },
    naturalHeight: { configurable: true, value: naturalHeight },
  })
  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue(new DOMRect(120, 80, width, height))
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 50, width + 40, height + 60))
  host.appendChild(image)
  document.body.appendChild(host)
  return { image, host }
}

beforeEach(() => {
  contexts = []; frames = new Map(); nextFrame = 0; stop = null
  vi.spyOn(performance, 'now').mockReturnValue(1000)
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, kind: string) {
    if (kind === 'webgl2') return null
    const context = makeContext(this)
    contexts.push(context)
    return context as unknown as CanvasRenderingContext2D
  })
})

afterEach(() => {
  stop?.()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('bounded canvas dust dissolve', () => {
  it('synchronously snapshots the decoded image and never reads it again after capture', () => {
    const { image, host } = fixture()
    stop = startCanvasDissolve(image, host)
    expect(stop).toBeTypeOf('function')
    const [overlay, snapshot, sample] = contexts
    expect(snapshot.drawImage).toHaveBeenCalledWith(image, 0, 0, 800, 600)
    expect(sample.drawImage).toHaveBeenCalledWith(snapshot.canvas, 0, 0, expect.any(Number), expect.any(Number))
    expect(overlay.drawImage).toHaveBeenCalledWith(snapshot.canvas, 72, 72, 800, 600)
    expect(sample.getImageData).toHaveBeenCalledOnce()
    expect(sample.canvas.width).toBe(0)
    expect(overlay.canvas.getAttribute('aria-hidden')).toBe('true')
    expect(overlay.canvas.style.pointerEvents).toBe('none')
    expect(overlay.canvas.style.position).toBe('absolute')
    image.removeAttribute('src')
    image.remove()
    tick(1016); tick(1200)
    expect(snapshot.drawImage).toHaveBeenCalledOnce()
    expect(sample.getImageData).toHaveBeenCalledOnce()
    expect(overlay.getImageData).not.toHaveBeenCalled()
    expect(snapshot.getImageData).not.toHaveBeenCalled()
    expect(overlay.fillRect).toHaveBeenCalled()
    expect(frames.size).toBe(1)
  })

  it.each([
    [800, 600, 400, 800, 322, 72, 300, 600],
    [800, 600, 1600, 800, 72, 172, 800, 400],
  ])('matches centered contain geometry for %sx%s boxes and %sx%s images', (w, h, nw, nh, left, top, iw, ih) => {
    const { image, host } = fixture(w, h, nw, nh)
    Object.defineProperties(host, { clientLeft: { value: 2 }, clientTop: { value: 3 } })
    host.scrollLeft = 7; host.scrollTop = 11
    stop = startCanvasDissolve(image, host)
    const [overlay, snapshot] = contexts
    expect(overlay.drawImage).toHaveBeenCalledWith(snapshot.canvas, left, top, iw, ih)
    expect(overlay.canvas.style.left).toBe('-47px')
    expect(overlay.canvas.style.top).toBe('-34px')
    expect(overlay.canvas.style.width).toBe('944px')
    expect(overlay.canvas.style.height).toBe('744px')
  })

  it.each([['0.42', '0.42'], ['', '1'], ['NaN', '1'], ['-0.5', '0'], ['1.5', '1']])(
    'preserves finite clamped entrance opacity %s as static overlay opacity %s', (opacity, expected) => {
      const { image, host } = fixture()
      vi.spyOn(window, 'getComputedStyle').mockReturnValue({ opacity } as CSSStyleDeclaration)
      stop = startCanvasDissolve(image, host)
      const overlay = contexts[0].canvas
      expect(overlay.style.opacity).toBe(expected)
      tick(1350)
      expect(overlay.style.opacity).toBe(expected)
    },
  )

  it.each([[7680, 4320, 4], [2560, 2560, 2], [300, 200, 4], [10000, 2, 2]])(
    'bounds backing size, effective DPR and the sampled particle count at %sx%s DPR %s', (width, height, dpr) => {
      vi.stubGlobal('devicePixelRatio', dpr)
      const { image, host } = fixture(width, height, width, height)
      stop = startCanvasDissolve(image, host)
      expect(stop).not.toBeNull()
      const [overlay, snapshot, sample] = contexts
      for (const context of [overlay, snapshot]) {
        expect(Math.max(context.canvas.width, context.canvas.height)).toBeLessThanOrEqual(1280)
        expect(context.canvas.width * context.canvas.height).toBeLessThanOrEqual(1_000_000)
      }
      expect(overlay.canvas.width / (width + 144)).toBeLessThanOrEqual(1.5)
      expect(snapshot.canvas.width / width).toBeLessThanOrEqual(1.5)
      const [, , columns, rows] = sample.getImageData.mock.calls[0]
      expect(columns * rows).toBeGreaterThan(0)
      expect(columns * rows).toBeLessThanOrEqual(2400)
      tick(1450)
      expect(overlay.fillRect.mock.calls.length).toBeLessThanOrEqual(2400)
    },
  )

  it('uses a compact thumbnail budget so two simultaneous deletions stay bounded', () => {
    const { image, host } = fixture(2560, 1440, 2560, 1440)
    stop = startCanvasDissolve(image, host, 'thumbnail')
    const [overlay, snapshot, sample] = contexts
    for (const context of [overlay, snapshot]) {
      expect(context.canvas.width * context.canvas.height).toBeLessThanOrEqual(300_000)
      expect(Math.max(context.canvas.width, context.canvas.height)).toBeLessThanOrEqual(640)
    }
    const [, , columns, rows] = sample.getImageData.mock.calls[0]
    expect(columns * rows).toBeLessThanOrEqual(1200)
  })

  it('keeps contiguous opaque patches before they turn into moving, fading fine grains', () => {
    const { image, host } = fixture()
    stop = startCanvasDissolve(image, host)
    const [overlay] = contexts
    tick(1017)
    expect(overlay.fillRect).not.toHaveBeenCalled()
    expect(overlay.drawImage.mock.calls.length).toBeGreaterThan(1)
    const [scaleX, , , scaleY] = overlay.setTransform.mock.calls[0] as number[]
    const patches = overlay.drawImage.mock.calls.filter(call => call.length === 9) as number[][]
    for (const [, , , , , x, y, width, height] of patches) {
      for (const [value, scale] of [[x, scaleX], [y, scaleY], [width, scaleX], [height, scaleY]]) {
        expect(value * scale).toBeCloseTo(Math.round(value * scale), 8)
      }
    }
    for (let index = 1; index < patches.length; index++) {
      const previous = patches[index - 1], current = patches[index]
      if (current[6] === previous[6]) expect(current[5]).toBeCloseTo(previous[5] + previous[7], 8)
    }
    overlay.drawImage.mockClear()
    tick(1350)
    expect(overlay.fillRect).toHaveBeenCalled()
    for (const [, , width, height] of overlay.fillRect.mock.calls as number[][]) {
      expect(width).toBeGreaterThan(0)
      expect(width).toBeLessThan(3)
      expect(height).toBe(width)
    }
    const first = overlay.fillRect.mock.calls[0]
    overlay.fillRect.mockClear()
    overlay.drawImage.mockClear()
    tick(2100)
    expect(overlay.fillRect.mock.calls[0]).not.toEqual(first)
    expect(overlay.drawImage.mock.calls.length).toBeLessThan(2400)
    expect(overlay.globalAlpha).toBe(1)
  })

  it('returns null on a tainted readback and releases every allocated backing without mounting', () => {
    const { image, host } = fixture()
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(function (this: HTMLCanvasElement, kind: string) {
      if (kind === 'webgl2') return null
      const context = makeContext(this)
      context.getImageData.mockImplementation(() => { throw new DOMException('Tainted canvas', 'SecurityError') })
      contexts.push(context)
      return context as unknown as CanvasRenderingContext2D
    })
    expect(startCanvasDissolve(image, host)).toBeNull()
    expect(host.querySelector('canvas')).toBeNull()
    expect(frames.size).toBe(0)
    expect(contexts.every(({ canvas }) => canvas.width === 0 && canvas.height === 0)).toBe(true)
    expect(image.src).toBe('blob:already-decoded-image')
  })

  it('returns null if canvas contexts are unavailable', () => {
    const { image, host } = fixture()
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null)
    expect(startCanvasDissolve(image, host)).toBeNull()
    expect(host.querySelector('canvas')).toBeNull()
    expect(frames.size).toBe(0)
  })

  it.each(['undecoded', 'empty', 'hidden'] as const)('skips %s images before allocating canvases', state => {
    const { image, host } = fixture()
    if (state === 'undecoded') Object.defineProperty(image, 'complete', { value: false })
    if (state === 'empty') Object.defineProperty(image, 'naturalWidth', { value: 0 })
    if (state === 'hidden') vi.mocked(image.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 0, 0))
    expect(startCanvasDissolve(image, host)).toBeNull()
    expect(contexts).toHaveLength(0)
    expect(frames.size).toBe(0)
  })

  it.each([['canvas', 1480], ['thumbnail', 740]] as const)('completes %s at %s ms and releases all canvas storage', (profile, duration) => {
    const { image, host } = fixture()
    const onHandoff = vi.fn(), onComplete = vi.fn()
    stop = startCanvasDissolve(image, host, profile, { onHandoff, onComplete })
    tick(1000 + duration - 100)
    expect(host.querySelector('canvas')).not.toBeNull()
    expect(onHandoff).toHaveBeenCalledOnce()
    expect(onComplete).not.toHaveBeenCalled()
    tick(1000 + duration)
    expect(host.querySelector('canvas')).toBeNull()
    expect(frames.size).toBe(0)
    expect(contexts.every(({ canvas }) => canvas.width === 0 && canvas.height === 0)).toBe(true)
    expect(() => { stop?.(); stop?.() }).not.toThrow()
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it.each([144, 240])('caps paints on a %s Hz display while ending at 1480 ms', hz => {
    const { image, host } = fixture()
    stop = startCanvasDissolve(image, host)
    const overlay = contexts[0]
    for (let index = 1; index * 1000 / hz < 1480; index++) tick(1000 + index * 1000 / hz)
    expect(overlay.clearRect.mock.calls.length).toBeGreaterThan(40)
    expect(overlay.clearRect.mock.calls.length).toBeLessThanOrEqual(Math.floor(1480 * 60 / 1000))
    // Extra callbacks in the current paint slot cannot add work or lose ownership.
    const painted = overlay.clearRect.mock.calls.length
    tick(2478); tick(2479)
    expect(overlay.clearRect).toHaveBeenCalledTimes(painted)
    expect(frames.size).toBe(1)
    tick(2480)
    expect(host.querySelector('canvas')).toBeNull()
    expect(frames.size).toBe(0)
  })

  it('cancels even frame id zero, tolerates double cancellation and ignores an already queued callback', () => {
    const { image, host } = fixture()
    stop = startCanvasDissolve(image, host)
    const queued = frames.get(0)!
    stop?.(); stop?.()
    expect(cancelAnimationFrame).toHaveBeenCalledExactlyOnceWith(0)
    queued(1400)
    expect(contexts[0].clearRect).not.toHaveBeenCalled()
    expect(host.querySelector('canvas')).toBeNull()
    expect(frames.size).toBe(0)
    expect(contexts.every(({ canvas }) => canvas.width === 0 && canvas.height === 0)).toBe(true)
  })
})

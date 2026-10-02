import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startCanvasParticleReveal } from './canvasParticleReveal'

type Effect = NonNullable<ReturnType<typeof startCanvasParticleReveal>>
type MockAnimation = {
  finished: Promise<Animation>
  cancel: ReturnType<typeof vi.fn>
  finish: () => void
  reject: () => void
}
const canvases: HTMLCanvasElement[] = []
const animations: MockAnimation[] = []
const effects: Effect[] = []
const drawImage = vi.fn(), getImageData = vi.fn(), requestFrame = vi.fn(), arc = vi.fn(), fill = vi.fn()
let animateDescriptor: PropertyDescriptor | undefined
let animate: ReturnType<typeof vi.fn>
let failure: 'context' | 'draw' | 'animate' | 'readback' | null
let peakPixels = 0

function fixture(naturalWidth = 4000, naturalHeight = 2000) {
  const image = document.createElement('img'), host = document.createElement('div')
  Object.defineProperties(image, {
    complete: { configurable: true, value: true },
    naturalWidth: { configurable: true, value: naturalWidth },
    naturalHeight: { configurable: true, value: naturalHeight },
  })
  Object.defineProperties(host, { clientLeft: { value: 2 }, clientTop: { value: 3 } })
  host.scrollLeft = 11; host.scrollTop = 17
  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue(new DOMRect(80, 120, 1000, 900))
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 40, 1200, 1100))
  host.append(image)
  return { image, host }
}

function start(image: HTMLImageElement, host: HTMLElement) {
  const effect = startCanvasParticleReveal(image, host, 960)
  expect(effect).not.toBeNull()
  effects.push(effect!)
  return effect!
}

function expectReleased(host: HTMLElement) {
  expect(host.children).toHaveLength(1)
  expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true)
  expect(animations.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true)
  expect(requestFrame).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  failure = null; peakPixels = 0
  vi.stubGlobal('devicePixelRatio', 3)
  vi.stubGlobal('requestAnimationFrame', requestFrame)
  getImageData.mockImplementation((_x: number, _y: number, width: number, height: number) => {
    if (failure === 'readback') throw new DOMException('Cross-origin canvas', 'SecurityError')
    const data = new Uint8ClampedArray(width * height * 4)
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 80; data[index + 1] = 120; data[index + 2] = 180; data[index + 3] = 255
    }
    return { data }
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, kind: string) {
    expect(kind).toBe('2d')
    const index = canvases.push(this) - 1
    peakPixels = Math.max(peakPixels, canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0))
    if (failure === 'context' && index === 3) return null
    return {
      drawImage,
      getImageData,
      setTransform: vi.fn(), beginPath: vi.fn(), arc,
      fill: (...args: unknown[]) => {
        if (failure === 'draw' && index === 3) throw new Error('Canvas draw failed')
        fill(...args)
      },
    } as unknown as CanvasRenderingContext2D
  })
  animateDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
  animate = vi.fn(() => {
    if (failure === 'animate' && animations.length === 2) throw new Error('Animation creation failed')
    let resolve!: (animation: Animation) => void, reject!: (error: Error) => void
    const finished = new Promise<Animation>((done, fail) => { resolve = done; reject = fail })
    const animation: MockAnimation = {
      finished,
      cancel: vi.fn(() => reject(new DOMException('Canceled', 'AbortError'))),
      finish: () => resolve(animation as unknown as Animation),
      reject: () => reject(new Error('Animation interrupted')),
    }
    animations.push(animation)
    return animation as unknown as Animation
  })
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, writable: true, value: animate })
})

afterEach(async () => {
  effects.forEach(effect => effect.stop())
  await Promise.allSettled(effects.map(effect => effect.finished))
  effects.length = 0; canvases.length = 0; animations.length = 0
  if (animateDescriptor) Object.defineProperty(Element.prototype, 'animate', animateDescriptor)
  else Reflect.deleteProperty(Element.prototype, 'animate')
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it.each([
  { shape: 'landscape', natural: [4000, 2000], bounds: [69, 294, 1000, 500] },
  { shape: 'portrait', natural: [2000, 4000], bounds: [344, 94, 450, 900] },
])('prepares bounded $shape particles aligned to contain, host borders, and scrolling', ({ natural, bounds }) => {
  const { image, host } = fixture(natural[0], natural[1])
  image.style.opacity = '.85'; image.style.transform = 'none'
  const originalStyle = image.getAttribute('style')
  start(image, host)
  const layer = host.lastElementChild as HTMLElement
  expect([layer.style.left, layer.style.top, layer.style.width, layer.style.height].map(Number.parseFloat)).toEqual(bounds)
  expect(peakPixels).toBeLessThanOrEqual(1_000_000 + 2600)
  expect(peakPixels).toBeGreaterThan(0)
  expect(canvases[0].width * canvases[0].height).toBe(0)
  expect(drawImage.mock.calls.filter(([source]) => source === image)).toHaveLength(1)
  expect(getImageData).toHaveBeenCalledOnce()
  const [, , sampleWidth, sampleHeight] = getImageData.mock.calls[0]
  expect(sampleWidth * sampleHeight).toBeLessThanOrEqual(2600)
  expect(canvases.slice(1).reduce((sum, canvas) => sum + canvas.width * canvas.height, 0)).toBeLessThanOrEqual(1_000_000)
  expect(canvases.slice(1).every(canvas => Math.max(canvas.width, canvas.height) <= 768)).toBe(true)
  expect(arc).toHaveBeenCalled()
  expect(fill).toHaveBeenCalled()
  expect(requestFrame).not.toHaveBeenCalled()
  expect(image.getAttribute('style')).toBe(originalStyle)
  expect(animate.mock.contexts.filter(context => context === image)).toHaveLength(1)
  for (const [index, [frames, options]] of animate.mock.calls.entries()) {
    const allowed = animate.mock.contexts[index] === image ? ['opacity', 'offset', 'easing'] : ['opacity', 'transform', 'offset', 'easing']
    expect((frames as Keyframe[]).every(frame => Object.keys(frame).every(key => allowed.includes(key)))).toBe(true)
    expect(options.fill).toBe('both')
    expect(options.duration + (options.delay ?? 0)).toBeLessThanOrEqual(960)
  }
})

it('keeps the layers until every group finishes, then releases them without another paint', async () => {
  const { image, host } = fixture()
  const effect = start(image, host)
  const paints = fill.mock.calls.length
  let completed = false
  void effect.finished.then(() => { completed = true })
  expect(animations.length).toBeGreaterThan(1)
  animations.slice(0, -1).forEach(animation => animation.finish())
  await Promise.resolve()
  expect(completed).toBe(false)
  expect(host.children.length).toBeGreaterThan(1)
  animations.at(-1)!.finish()
  await effect.finished
  effect.stop(); effect.stop()
  expectReleased(host)
  expect(fill).toHaveBeenCalledTimes(paints)
  expect(image.style.opacity).toBe('')
  expect(image.style.transform).toBe('')
})

it.each(['stop', 'rejected animation'])('releases every group after %s and tolerates repeated cleanup', async reason => {
  const { image, host } = fixture()
  image.style.opacity = '.85'; image.style.transform = 'none'
  const originalStyle = image.getAttribute('style')
  const effect = start(image, host)
  if (reason === 'stop') { effect.stop(); effect.stop() }
  else animations[1].reject()
  await effect.finished
  effect.stop()
  animations.forEach(animation => animation.finish())
  expectReleased(host)
  expect(image.getAttribute('style')).toBe(originalStyle)
})

it.each(['context', 'draw', 'animate'] as const)('cleans earlier groups when a later %s operation fails', async operation => {
  failure = operation
  const { image, host } = fixture()
  expect(startCanvasParticleReveal(image, host, 960)).toBeNull()
  if (operation === 'animate') expect(animations).toHaveLength(2)
  else expect(canvases.length).toBeGreaterThanOrEqual(4)
  await Promise.allSettled(animations.map(animation => animation.finished))
  expectReleased(host)
  expect(image.style.opacity).toBe('')
  expect(image.style.transform).toBe('')
})

it('leaves the original available when cross-origin sampling is rejected', () => {
  failure = 'readback'
  const { image, host } = fixture()
  image.style.opacity = '.85'; image.style.transform = 'none'
  const originalStyle = image.getAttribute('style')
  expect(startCanvasParticleReveal(image, host, 960)).toBeNull()
  expect(getImageData).toHaveBeenCalledOnce()
  expect(animate).not.toHaveBeenCalled()
  expectReleased(host)
  expect(image.getAttribute('style')).toBe(originalStyle)
})

it('skips empty, undecoded, and zero-size images without allocating an effect', () => {
  const empty = fixture(0, 0)
  const pending = fixture()
  Object.defineProperty(pending.image, 'complete', { value: false })
  const hidden = fixture()
  vi.mocked(hidden.image.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 0, 0))
  for (const { image, host } of [empty, pending, hidden]) {
    expect(startCanvasParticleReveal(image, host, 960)).toBeNull()
    expect(host.children).toHaveLength(1)
  }
  expect(canvases).toHaveLength(0)
  expect(animate).not.toHaveBeenCalled()
  expect(drawImage).not.toHaveBeenCalled()
})

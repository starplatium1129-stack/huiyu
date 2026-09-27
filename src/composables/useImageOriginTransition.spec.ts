import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { useImageOriginTransition } from './useImageOriginTransition'

const animations: { finish: () => void; cancel: ReturnType<typeof vi.fn>; frames: Keyframe[]; options: KeyframeAnimationOptions }[] = []
const wrappers: VueWrapper[] = []
const originalAnimate = Element.prototype.animate
const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} })

beforeEach(() => {
  animations.length = 0
  document.documentElement.dataset.motion = 'full'
  vi.stubGlobal('innerWidth', 1440); vi.stubGlobal('innerHeight', 960)
  const createElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((tag, options) => {
    const element = createElement(tag, options)
    if (element instanceof HTMLImageElement) {
      Object.defineProperties(element, {
        complete: { value: true, configurable: true }, naturalWidth: { value: 100, configurable: true }, naturalHeight: { value: 200, configurable: true },
      })
      element.decode = vi.fn(async () => {})
    }
    return element
  })
  Element.prototype.animate = vi.fn(function (_frames, options) {
    let finish!: () => void, reject!: (reason?: unknown) => void
    const finished = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail })
    const cancel = vi.fn(() => reject(new Error('cancelled')))
    animations.push({ finish, cancel, frames: _frames as Keyframe[], options: options as KeyframeAnimationOptions })
    return { finished, cancel } as unknown as Animation
  })
})
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  document.body.innerHTML = ''
  delete document.documentElement.dataset.motion
  Element.prototype.animate = originalAnimate
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

function setup() {
  let motion!: ReturnType<typeof useImageOriginTransition>
  wrappers.push(mount(defineComponent({ setup() { motion = useImageOriginTransition(); return () => h('div') } })))
  const source = document.createElement('img'), target = document.createElement('img'), host = document.createElement('div')
  source.src = '/source.png'; target.src = '/target.png'
  for (const image of [source, target]) {
    Object.defineProperties(image, { complete: { value: true, configurable: true }, naturalWidth: { value: 100 }, naturalHeight: { value: 200 } })
    image.decode = vi.fn(async () => {})
  }
  vi.spyOn(source, 'getBoundingClientRect').mockReturnValue(box(30, 50, 100, 200))
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(box(300, 100, 400, 800))
  host.append(target); document.body.append(source, host)
  motion.capture(source)
  return { motion, source, target, host, proxy: () => host.querySelector<HTMLImageElement>('[data-image-origin-proxy]') }
}

function nextProxy() {
  const proxy = document.createElement('img')
  vi.mocked(document.createElement).mockReturnValueOnce(proxy)
  return proxy
}

it.each(['anonymous', 'use-credentials', null])('copies the target request policy before proxy src (%s)', async crossOrigin => {
  const env = setup(), proxy = nextProxy()
  env.target.crossOrigin = crossOrigin
  env.target.referrerPolicy = 'no-referrer'
  const srcSetter = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!.set!
  const requests: { crossOrigin: string | null; referrerPolicy: string; src: string }[] = []
  vi.spyOn(proxy, 'src', 'set').mockImplementation(function (value) {
    requests.push({ crossOrigin: proxy.crossOrigin, referrerPolicy: proxy.referrerPolicy, src: value })
    srcSetter.call(proxy, value)
  })
  const entered = env.motion.enter(env.target, env.host)
  await flushPromises()
  expect(requests).toEqual([{ crossOrigin, referrerPolicy: 'no-referrer', src: env.target.src }])
  expect(proxy.decoding).toBe('async')
  expect(proxy.loading).toBe('eager')
  expect(proxy.hasAttribute('srcset')).toBe(false)
  animations[0].finish(); await entered
})

it.each(['broken', 'rejected', 'thrown'])('leaves the decoded target visible when the proxy is %s', async failure => {
  const env = setup(), proxy = nextProxy()
  env.target.style.opacity = '0.9'; env.target.style.transition = 'opacity 200ms'
  if (failure === 'broken') Object.defineProperty(proxy, 'naturalWidth', { value: 0 })
  if (failure === 'rejected') proxy.decode = vi.fn(async () => { throw new Error('proxy rejected') })
  if (failure === 'thrown') proxy.decode = vi.fn(() => { throw new Error('decode unavailable') })
  await env.motion.enter(env.target, env.host)
  expect(env.proxy()).toBeNull()
  expect(env.target.style.opacity).toBe('0.9')
  expect(env.target.style.transition).toBe('opacity 200ms')
  expect(proxy.hasAttribute('src')).toBe(false)
  expect(animations).toHaveLength(0)
})

it('does not append or hide the target while its proxy is loading, including a later load error', async () => {
  const env = setup(), proxy = nextProxy()
  Object.defineProperty(proxy, 'complete', { value: false })
  const entered = env.motion.enter(env.target, env.host)
  await flushPromises()
  expect(env.proxy()).toBeNull()
  expect(env.target.style.opacity).toBe('')
  proxy.dispatchEvent(new Event('error'))
  await entered
  expect(proxy.hasAttribute('src')).toBe(false)
  expect(env.target.style.opacity).toBe('')
  expect(animations).toHaveLength(0)
})

it('shares the 180ms opening deadline across target and proxy decoding', async () => {
  vi.useFakeTimers()
  const env = setup(), proxy = nextProxy()
  let targetDecoded!: () => void, proxyDecoded!: () => void
  env.target.decode = vi.fn(() => new Promise<void>(resolve => { targetDecoded = resolve }))
  proxy.decode = vi.fn(() => new Promise<void>(resolve => { proxyDecoded = resolve }))
  const entered = env.motion.enter(env.target, env.host)
  await vi.advanceTimersByTimeAsync(120)
  targetDecoded(); await vi.advanceTimersByTimeAsync(0)
  expect(proxy.decode).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(60); await entered
  proxyDecoded(); await vi.advanceTimersByTimeAsync(0)
  expect(env.proxy()).toBeNull()
  expect(proxy.hasAttribute('src')).toBe(false)
  expect(env.target.style.opacity).toBe('')
  expect(animations).toHaveLength(0)
})

it('settles a superseded proxy wait and ignores its late decode without clearing the new flight', async () => {
  const env = setup(), first = nextProxy()
  let oldDecoded!: () => void
  first.decode = vi.fn(() => new Promise<void>(resolve => { oldDecoded = resolve }))
  const old = env.motion.enter(env.target, env.host)
  await flushPromises()
  const second = nextProxy()
  const entered = env.motion.enter(env.target, env.host)
  await old; await flushPromises()
  expect(first.hasAttribute('src')).toBe(false)
  expect(env.proxy()).toBe(second)
  oldDecoded(); await flushPromises()
  expect(env.proxy()).toBe(second)
  expect(env.target.style.opacity).toBe('0')
  animations[0].finish(); await entered
})

it('settles and drops a pending proxy when the owner unmounts', async () => {
  const env = setup(), proxy = nextProxy()
  let decoded!: () => void
  proxy.decode = vi.fn(() => new Promise<void>(resolve => { decoded = resolve }))
  const entered = env.motion.enter(env.target, env.host)
  await flushPromises()
  wrappers[0].unmount(); await entered
  decoded(); await flushPromises()
  expect(proxy.hasAttribute('src')).toBe(false)
  expect(env.proxy()).toBeNull()
  expect(env.target.style.opacity).toBe('')
  expect(animations).toHaveLength(0)
})

it.each(['detached', 'changed'])('discards a decoded proxy when its target was %s while waiting', async change => {
  const env = setup(), proxy = nextProxy()
  let decoded!: () => void
  proxy.decode = vi.fn(() => new Promise<void>(resolve => { decoded = resolve }))
  const entered = env.motion.enter(env.target, env.host)
  await flushPromises()
  if (change === 'detached') env.target.remove()
  else env.target.src = '/new-target.png'
  decoded(); await entered
  expect(proxy.hasAttribute('src')).toBe(false)
  expect(env.proxy()).toBeNull()
  expect(env.target.style.opacity).toBe('')
  expect(animations).toHaveLength(0)
})

it('keeps the in-flight source snapshot valid if the next capture changes during proxy decoding', async () => {
  const env = setup(), proxy = nextProxy()
  let decoded!: () => void
  proxy.decode = vi.fn(() => new Promise<void>(resolve => { decoded = resolve }))
  const entered = env.motion.enter(env.target, env.host)
  await flushPromises()
  env.motion.capture(null)
  decoded(); await flushPromises()
  expect(animations[0].frames[0]).toEqual({ transform: 'translate(30px, 50px) scale(0.25, 0.25)' })
  animations[0].finish(); await entered
})

it('falls back on a closing proxy cache miss within 20ms without hiding the real image', async () => {
  vi.useFakeTimers()
  const env = setup(), proxy = nextProxy()
  let decoded!: () => void
  proxy.decode = vi.fn(() => new Promise<void>(resolve => { decoded = resolve }))
  const leaving = env.motion.leave(env.target, env.host, env.source)
  await vi.advanceTimersByTimeAsync(20); await leaving
  decoded(); await vi.advanceTimersByTimeAsync(0)
  expect(proxy.hasAttribute('src')).toBe(false)
  expect(env.proxy()).toBeNull()
  expect(env.target.style.opacity).toBe('')
  expect(animations).toHaveLength(0)
})

it('deducts closing proxy decode time so the complete flight stays within 280ms', async () => {
  vi.useFakeTimers()
  const env = setup(), proxy = nextProxy()
  let decoded!: () => void
  proxy.decode = vi.fn(() => new Promise<void>(resolve => { decoded = resolve }))
  const leaving = env.motion.leave(env.target, env.host, env.source)
  await vi.advanceTimersByTimeAsync(12)
  decoded(); await vi.advanceTimersByTimeAsync(0)
  expect(animations[0].options.duration).toBe(268)
  animations[0].finish(); await leaving
  env.motion.cancel()
  expect(env.proxy()).toBeNull()
  expect(env.target.style.opacity).toBe('')
})

it('flies from the source rectangle and restores the real image after entering', async () => {
  const env = setup()
  env.target.style.transition = 'opacity 200ms'
  const done = env.motion.enter(env.target, env.host)
  await flushPromises()
  expect(env.proxy()).not.toBeNull()
  expect(env.target.style.opacity).toBe('0')
  expect(animations[0].frames).toEqual([{ transform: 'translate(30px, 50px) scale(0.25, 0.25)' }, { transform: 'translate(300px, 100px) scale(1, 1)' }])
  animations[0].finish(); await done
  expect(env.proxy()).toBeNull()
  expect(env.target.style.opacity).toBe('')
  expect(env.target.style.transition).toBe('opacity 200ms')
})

it('retargets from the current flight and does not settle a new flight on an old cancel rejection', async () => {
  const env = setup()
  const entered = env.motion.enter(env.target, env.host)
  await flushPromises()
  const proxy = env.proxy()!
  vi.spyOn(proxy, 'getBoundingClientRect').mockReturnValue(box(150, 80, 200, 400))
  let closed = false
  const leaving = env.motion.leave(env.target, env.host, env.source).then(() => { closed = true })
  await entered; await flushPromises()
  expect(closed).toBe(false)
  expect(env.proxy()).toBe(proxy)
  expect(animations[1].frames[0]).toEqual({ transform: 'translate(150px, 80px) scale(0.5, 0.5)' })
  animations[1].finish(); await leaving
  expect(env.proxy()).toBe(proxy)
  expect(env.target.style.opacity).toBe('0')
  env.motion.cancel()
  expect(env.proxy()).toBeNull()
  expect(env.target.style.opacity).toBe('')
})

it('keeps capture through cancellation and never animates a blurred, hidden or offscreen source', async () => {
  const env = setup()
  env.motion.cancel()
  const entered = env.motion.enter(env.target, env.host)
  await flushPromises(); expect(env.proxy()).not.toBeNull()
  env.motion.cancel(); await entered
  env.source.style.filter = 'blur(12px)'
  env.motion.capture(env.source)
  await env.motion.enter(env.target, env.host)
  expect(env.proxy()).toBeNull()
  env.source.style.filter = 'none'; env.source.style.opacity = '0'
  env.motion.capture(env.source)
  await env.motion.enter(env.target, env.host)
  expect(env.proxy()).toBeNull()
  env.source.style.opacity = '1'
  vi.mocked(env.source.getBoundingClientRect).mockReturnValue(box(-200, 0, 100, 200))
  env.motion.capture(env.source)
  await env.motion.enter(env.target, env.host)
  expect(animations).toHaveLength(1)
})

it('bounds image readiness and cannot launch a late flight after timing out', async () => {
  vi.useFakeTimers()
  const env = setup()
  let decode!: () => void
  env.target.decode = vi.fn(() => new Promise<void>(resolve => { decode = resolve }))
  const entered = env.motion.enter(env.target, env.host)
  await vi.advanceTimersByTimeAsync(180)
  await entered
  decode(); await Promise.resolve()
  expect(env.proxy()).toBeNull()
  expect(animations).toHaveLength(0)
})

it('does not start a late flight when the viewer image only mounts after the capture deadline', async () => {
  vi.useFakeTimers()
  const env = setup()
  await vi.advanceTimersByTimeAsync(181)
  await env.motion.enter(env.target, env.host)
  expect(animations).toHaveLength(0)
})

it('falls back without revealing zoom-clipped pixels or stretching a differently cropped thumbnail', async () => {
  const env = setup()
  vi.mocked(env.target.getBoundingClientRect).mockReturnValue(box(0, -100, 800, 1600))
  await env.motion.leave(env.target, env.host, env.source)
  expect(env.proxy()).toBeNull()
  vi.mocked(env.target.getBoundingClientRect).mockReturnValue(box(300, 100, 400, 400))
  await env.motion.leave(env.target, env.host, env.source)
  expect(env.proxy()).toBeNull()
  expect(animations).toHaveLength(0)
})

it('cleans up the previous flight when a replacement image disappears while decoding', async () => {
  const env = setup(), replacement = setup().target
  const entering = env.motion.enter(env.target, env.host)
  await flushPromises()
  let decoded!: () => void
  replacement.decode = vi.fn(() => new Promise<void>(resolve => { decoded = resolve }))
  const replacing = env.motion.enter(replacement, env.host)
  replacement.remove(); decoded()
  await replacing
  expect(env.proxy()).toBeNull()
  await entering
})

it('settles pending promises and removes floating images when unmounted or reduced motion is enabled', async () => {
  const env = setup()
  const entered = env.motion.enter(env.target, env.host)
  await flushPromises()
  document.documentElement.dataset.motion = 'reduce'
  window.dispatchEvent(new Event('atelier:motion-preference'))
  await entered
  expect(env.proxy()).toBeNull()
  expect(env.target.style.opacity).toBe('')
  await env.motion.leave(env.target, env.host, env.source)
  expect(animations).toHaveLength(1)
  document.documentElement.dataset.motion = 'full'
  const leaving = env.motion.leave(env.target, env.host, env.source)
  wrappers[0].unmount(); await leaving
  expect(env.proxy()).toBeNull()
  expect(env.target.style.opacity).toBe('')
})

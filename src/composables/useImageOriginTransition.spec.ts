import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { useImageOriginTransition } from './useImageOriginTransition'

const animations: { finish: () => void; cancel: ReturnType<typeof vi.fn>; frames: Keyframe[] }[] = []
const wrappers: VueWrapper[] = []
const originalAnimate = Element.prototype.animate
const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} })

beforeEach(() => {
  animations.length = 0
  document.documentElement.dataset.motion = 'full'
  vi.stubGlobal('innerWidth', 1440); vi.stubGlobal('innerHeight', 960)
  Element.prototype.animate = vi.fn(function (_frames) {
    let finish!: () => void, reject!: (reason?: unknown) => void
    const finished = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail })
    const cancel = vi.fn(() => reject(new Error('cancelled')))
    animations.push({ finish, cancel, frames: _frames as Keyframe[] })
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

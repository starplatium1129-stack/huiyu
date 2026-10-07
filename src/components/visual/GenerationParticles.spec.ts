import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import GenerationParticles from './GenerationParticles.vue'
import GenerationBloomShader from './GenerationBloomShader.vue'

const frames = vi.hoisted(() => new Set<(now: number, delta?: number) => void>())
vi.mock('@/utils/particleScheduler', () => ({ registerParticleFrame: (frame: (now: number, delta?: number) => void) => {
  frames.add(frame)
  return () => frames.delete(frame)
} }))
const activity = { canPresent: ref(true), canAnimate: ref(true), lowEffects: ref(false), appearanceRevision: ref(0) }
vi.mock('@/composables/useVisualActivity', () => ({ useVisualActivity: () => activity }))
afterEach(() => { frames.clear(); vi.restoreAllMocks() })

it('owns one animation subscription, pauses hidden visuals and releases glow caches on unmount', async () => {
  const paint = {
    setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn<(image: HTMLCanvasElement, ...args: number[]) => void>(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn<(x: number, y: number) => void>(), lineTo: vi.fn(), stroke: vi.fn(),
    createRadialGradient: () => ({ addColorStop: vi.fn() }),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(paint as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 320, height: 232 } as DOMRect)
  const wrapper = mount(GenerationParticles, { props: { progress: 0.37 } })
  let glowCanvas: HTMLCanvasElement
  try {
    await nextTick()
    glowCanvas = paint.drawImage.mock.calls[0][0]
    expect(frames.size).toBe(1)
    const frame = [...frames][0]
    const first = paint.moveTo.mock.calls.at(-3)!
    const distance = (point: number[]) => Math.hypot(point[0] - 160, point[1] - 116)
    await wrapper.setProps({ progress: 0.96 })
    expect([...frames][0]).toBe(frame)
    frame(1000, 2000)
    expect(distance(paint.moveTo.mock.calls.at(-3)!)).toBeLessThan(distance(first) * .8)
    activity.canPresent.value = false; activity.canAnimate.value = false
    await nextTick()
    expect(frames.size).toBe(0)
    const previous = paint.clearRect.mock.calls.length
    activity.canPresent.value = true
    await nextTick()
    expect(frames.size).toBe(0)
    expect(paint.clearRect.mock.calls.length).toBeGreaterThan(previous)
    activity.canAnimate.value = true
    await nextTick()
    expect(frames.size).toBe(1)
  } finally { wrapper.unmount() }
  expect(frames.size).toBe(0)
  expect(glowCanvas!.width).toBe(0)
  expect(glowCanvas!.height).toBe(0)
})

it('owns shader frames and GPU objects, pauses while hidden and cleans a partial initialization', async () => {
  const context = {
    createShader: vi.fn(() => ({})), shaderSource: vi.fn(), compileShader: vi.fn(), getShaderParameter: vi.fn(() => true), deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({})), attachShader: vi.fn(), linkProgram: vi.fn(), getProgramParameter: vi.fn(() => true), deleteProgram: vi.fn(),
    createBuffer: vi.fn(() => ({})), bindBuffer: vi.fn(), bufferData: vi.fn(), deleteBuffer: vi.fn(), useProgram: vi.fn(),
    getAttribLocation: vi.fn(() => 0), enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(), getUniformLocation: vi.fn(() => ({})),
    viewport: vi.fn(), uniform1f: vi.fn(), uniform3f: vi.fn(), drawArrays: vi.fn(), getExtension: vi.fn(() => ({ loseContext })),
  }
  const loseContext = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as WebGL2RenderingContext)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 320, height: 232 } as DOMRect)
  const props = { progress: .55, colors: ['rgb(242 168 190)', 'rgb(157 221 221)', 'rgb(189 176 232)'], animate: true }
  const wrapper = mount(GenerationBloomShader, { props })
  try {
    expect(wrapper.emitted('ready')).toHaveLength(1)
    expect(frames.size).toBe(1)
    await wrapper.setProps({ animate: false })
    expect(frames.size).toBe(0)
    await wrapper.setProps({ animate: true })
    expect(frames.size).toBe(1)
    wrapper.find('canvas').element.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    expect(frames.size).toBe(0)
    expect(wrapper.emitted('unavailable')).toHaveLength(1)
  } finally { wrapper.unmount() }
  expect(context.deleteShader).toHaveBeenCalledTimes(2)
  expect(context.deleteBuffer).toHaveBeenCalledWith(expect.any(Object))
  expect(context.deleteProgram).toHaveBeenCalledWith(expect.any(Object))
  expect(loseContext).toHaveBeenCalledOnce()
  context.getShaderParameter.mockReturnValueOnce(true).mockReturnValueOnce(false)
  const failed = mount(GenerationBloomShader, { props })
  try {
    expect(failed.emitted('unavailable')).toHaveLength(1)
    expect(failed.emitted('ready')).toBeUndefined()
    expect(frames.size).toBe(0)
    expect(context.deleteShader).toHaveBeenCalledTimes(4)
  } finally { failed.unmount() }
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValueOnce(null)
  const unsupported = mount(GenerationBloomShader, { props })
  try {
    expect(unsupported.emitted('unavailable')).toHaveLength(1)
    expect(unsupported.emitted('ready')).toBeUndefined()
    expect(frames.size).toBe(0)
  } finally { unsupported.unmount() }
})

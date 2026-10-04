import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import GenerationParticles from './GenerationParticles.vue'

const frames = vi.hoisted(() => new Set<(now: number) => void>())
vi.mock('@/utils/particleScheduler', () => ({ registerParticleFrame: (frame: (now: number) => void) => {
  frames.add(frame)
  return () => frames.delete(frame)
} }))
const activity = { canPresent: ref(true), canAnimate: ref(true), lowEffects: ref(false), appearanceRevision: ref(0) }
vi.mock('@/composables/useVisualActivity', () => ({ useVisualActivity: () => activity }))
afterEach(() => { frames.clear(); vi.restoreAllMocks() })

it('owns one animation subscription, pauses hidden visuals and releases glow caches on unmount', async () => {
  const paint = {
    setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn<(image: HTMLCanvasElement, ...args: number[]) => void>(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
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
    await wrapper.setProps({ progress: 0.76 })
    expect([...frames][0]).toBe(frame)
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

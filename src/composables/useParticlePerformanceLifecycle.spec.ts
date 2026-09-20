import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { useParticlePerformanceLifecycle } from './useParticlePerformanceLifecycle'

function setup() {
  const hooks = {
    rebuild: vi.fn(), start: vi.fn(), stop: vi.fn(), resize: vi.fn(),
    cancelDeferred: vi.fn(), paletteChanged: vi.fn(), visible: () => true,
  }
  let lifecycle!: ReturnType<typeof useParticlePerformanceLifecycle>
  const wrapper = mount(defineComponent({ setup() {
    lifecycle = useParticlePerformanceLifecycle(hooks)
    return () => h('div')
  } }))
  return { hooks, lifecycle, wrapper }
}

afterEach(() => {
  delete document.documentElement.dataset.reducedMotion
  delete document.documentElement.dataset.fluidEffects
  delete document.documentElement.dataset.reducedGlass
})

describe('particle motion preferences', () => {
  it('keeps reduced motion when either the application or system requests it', () => {
    const { lifecycle, hooks, wrapper } = setup()
    document.documentElement.dataset.reducedMotion = 'true'
    lifecycle.syncEffectsPreference()
    expect(lifecycle.reduceMotion.value).toBe(true)
    expect(hooks.stop).toHaveBeenCalledOnce()
    lifecycle.onMotionPreference({ matches: true } as MediaQueryList)
    document.documentElement.dataset.reducedMotion = 'false'
    lifecycle.onRootPreferenceChanged()
    expect(lifecycle.reduceMotion.value).toBe(true)
    lifecycle.onMotionPreference({ matches: false } as MediaQueryList)
    expect(lifecycle.reduceMotion.value).toBe(false)
    expect(hooks.rebuild).toHaveBeenCalledTimes(2)
    expect(hooks.start).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('updates inactive preferences without scheduling frames or rebuilding', () => {
    const { lifecycle, hooks, wrapper } = setup()
    lifecycle.active.value = false
    document.documentElement.dataset.reducedMotion = 'true'
    lifecycle.syncEffectsPreference()
    expect(lifecycle.reduceMotion.value).toBe(true)
    expect(hooks.start).not.toHaveBeenCalled()
    expect(hooks.rebuild).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('applies low effects independently without erasing motion preference', () => {
    const { lifecycle, wrapper } = setup()
    lifecycle.onMotionPreference({ matches: true } as MediaQueryList)
    document.documentElement.dataset.fluidEffects = 'low'
    lifecycle.syncEffectsPreference()
    expect(lifecycle.lowEffects.value).toBe(true)
    expect(lifecycle.reduceMotion.value).toBe(true)
    document.documentElement.dataset.fluidEffects = 'full'
    lifecycle.syncEffectsPreference()
    expect(lifecycle.lowEffects.value).toBe(false)
    expect(lifecycle.reduceMotion.value).toBe(true)
    wrapper.unmount()
  })
})

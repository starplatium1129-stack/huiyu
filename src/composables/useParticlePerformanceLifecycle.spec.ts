import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, KeepAlive, nextTick, ref, type App } from 'vue'
import { useParticlePerformanceLifecycle } from './useParticlePerformanceLifecycle'

const media = vi.hoisted(() => {
  const query = { matches: false }
  vi.stubGlobal('matchMedia', () => query)
  return query
})

let app: App | undefined
let api: ReturnType<typeof useParticlePerformanceLifecycle>
const shown = ref(true)
const hooks = {
  rebuild: vi.fn(), start: vi.fn(), stop: vi.fn(), resize: vi.fn(),
  cancelDeferred: vi.fn(), paletteChanged: vi.fn(), visible: () => true,
}

async function mount() {
  const Page = defineComponent({ setup() {
    api = useParticlePerformanceLifecycle(hooks)
    return () => h('div')
  } })
  app = createApp({ setup: () => () => h(KeepAlive, null, { default: () => shown.value ? h(Page) : null }) })
  app.mount(document.createElement('div'))
  await nextTick()
  vi.clearAllMocks()
}

beforeEach(() => {
  shown.value = true
  media.matches = false
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
})
afterEach(() => {
  app?.unmount()
  app = undefined
  delete document.documentElement.dataset.motion
  delete document.documentElement.dataset.fluidEffects
  vi.restoreAllMocks()
})
afterAll(() => vi.unstubAllGlobals())

describe('particle performance motion preference', () => {
  it('stops for application reduce and resumes for full without an OS change', async () => {
    await mount()
    document.documentElement.dataset.motion = 'reduce'
    api.onRootPreferenceChanged()
    expect(api.reduceMotion.value).toBe(true)
    expect(hooks.stop).toHaveBeenCalledTimes(1)
    expect(hooks.rebuild).toHaveBeenCalledTimes(1)
    expect(hooks.start).not.toHaveBeenCalled()
    document.documentElement.dataset.motion = 'full'
    api.onRootPreferenceChanged()
    expect(api.reduceMotion.value).toBe(false)
    expect(hooks.start).toHaveBeenCalledTimes(1)
  })

  it('lets application full override OS reduce and falls back to OS for system mode', async () => {
    media.matches = true
    document.documentElement.dataset.motion = 'full'
    await mount()
    api.onMotionPreference(media as MediaQueryList)
    expect(api.reduceMotion.value).toBe(false)
    document.documentElement.dataset.motion = 'system'
    api.onRootPreferenceChanged()
    expect(api.reduceMotion.value).toBe(true)
    media.matches = false
    api.onMotionPreference(media as MediaQueryList)
    expect(api.reduceMotion.value).toBe(false)
    expect(hooks.start).toHaveBeenCalledTimes(1)
  })

  it('does not rebuild or restart a deactivated page on preference changes', async () => {
    await mount()
    shown.value = false
    await nextTick()
    vi.clearAllMocks()
    document.documentElement.dataset.motion = 'reduce'
    api.onRootPreferenceChanged()
    document.documentElement.dataset.fluidEffects = 'low'
    document.documentElement.dataset.motion = 'full'
    api.onRootPreferenceChanged()
    expect(hooks.start).not.toHaveBeenCalled()
    expect(hooks.rebuild).not.toHaveBeenCalled()
    expect(hooks.paletteChanged).not.toHaveBeenCalled()
    shown.value = true
    await nextTick()
    expect(hooks.resize).toHaveBeenCalledTimes(1)
    expect(hooks.start).toHaveBeenCalledTimes(1)
  })

  it('keeps reduced motion stopped through visibility and effects changes', async () => {
    document.documentElement.dataset.motion = 'reduce'
    await mount()
    expect(api.reduceMotion.value).toBe(true)
    document.documentElement.dataset.fluidEffects = 'low'
    api.onRootPreferenceChanged()
    api.onVisibilityChange()
    expect(hooks.start).not.toHaveBeenCalled()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, KeepAlive, nextTick, ref, type App } from 'vue'
import ToggleSwitch from './ToggleSwitch.vue'
let app: App | undefined, frames: Map<number, FrameRequestCallback>, id: number
const shown = ref(true), value = ref(false)
async function mount() {
  const Page = defineComponent({ setup: () => () => h(ToggleSwitch, { modelValue: value.value, label: '009 test switch' }) })
  const host = document.createElement('div'); document.body.append(host)
  app = createApp({ setup: () => () => h(KeepAlive, null, { default: () => shown.value ? h(Page) : null }) })
  app.mount(host); await nextTick(); return host
}
beforeEach(() => {
  shown.value = true; value.value = false; frames = new Map(); id = 0
  document.documentElement.dataset.motion = 'full'
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const next = id++; frames.set(next, callback); return next })
  vi.stubGlobal('cancelAnimationFrame', (value: number) => frames.delete(value))
})
afterEach(() => { app?.unmount(); app = undefined; document.body.replaceChildren(); delete document.documentElement.dataset.motion; vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('009 cached toggle lifecycle', () => {
  it('discards inactive animation work and resumes at the latest value over 20 cycles', async () => {
    const host = await mount(), knob = host.querySelector('.toggle-knob') as HTMLElement
    for (let i = 0; i < 20; i++) {
      value.value = true; await nextTick(); expect(frames.size).toBe(1)
      shown.value = false; await nextTick(); expect(frames.size).toBe(0)
      value.value = false; await nextTick(); expect(frames.size).toBe(0)
      shown.value = true; await nextTick(); expect(frames.size).toBe(0)
      expect(host.querySelector('.toggle-knob')).toBe(knob); expect(knob.style.transform).toBe('translateX(0px)')
    }
  })
  it('keeps the native checkbox accessible while releasing motion on unmount', async () => {
    const host = await mount(); expect(host.querySelector('input')!.getAttribute('aria-label')).toBe('009 test switch')
    value.value = true; await nextTick(); app!.unmount(); app = undefined; expect(frames.size).toBe(0)
  })
})

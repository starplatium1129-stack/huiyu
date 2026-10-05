import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import { useRoomPresentation } from './useRoomPresentation'
import { ROOM_PRESENTATION_KEY } from '@/utils/storageKeys'

const desktop = vi.hoisted(() => ({ active: true }))
vi.mock('../../platform/desktop/capabilities.ts', () => ({ getDesktopCapabilities: () => desktop.active ? {} : null }))
let wrapper: ReturnType<typeof mount> | undefined
beforeEach(() => {
  vi.useFakeTimers(); desktop.active = true; localStorage.removeItem(ROOM_PRESENTATION_KEY)
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(window, 'setInterval')
  vi.spyOn(globalThis, 'clearInterval')
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; localStorage.removeItem(ROOM_PRESENTATION_KEY); vi.restoreAllMocks(); vi.useRealTimers() })

function setup(surface: 'room' | 'companion') {
  const active = ref(true)
  const page = defineComponent({ setup() {
    const suspended = useRoomPresentation(surface)
    return () => h('output', String(suspended.value))
  } })
  wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, null, {
    default: () => active.value ? h(page) : null,
  }) }))
  return active
}

it('releases its own room ownership and interval while cached, then resumes without duplicates', async () => {
  const active = setup('room'); await nextTick()
  const own = JSON.parse(localStorage.getItem(ROOM_PRESENTATION_KEY)!)
  expect(wrapper!.text()).toBe('false')
  expect(window.setInterval).toHaveBeenCalledTimes(1)
  active.value = false; await nextTick()
  expect(localStorage.getItem(ROOM_PRESENTATION_KEY)).toBeNull()
  expect(clearInterval).toHaveBeenCalledWith(vi.mocked(window.setInterval).mock.results[0]!.value)
  window.dispatchEvent(new Event('focus'))
  expect(localStorage.getItem(ROOM_PRESENTATION_KEY)).toBeNull()
  active.value = true; await nextTick()
  expect(JSON.parse(localStorage.getItem(ROOM_PRESENTATION_KEY)!).id).toBe(own.id)
  expect(window.setInterval).toHaveBeenCalledTimes(2)
  localStorage.setItem(ROOM_PRESENTATION_KEY, JSON.stringify({ id: 'another-room', ts: Date.now() }))
  active.value = false; await nextTick()
  expect(JSON.parse(localStorage.getItem(ROOM_PRESENTATION_KEY)!).id).toBe('another-room')
})

it('keeps companion ownership read-only and falls back to browser presentation after resume', async () => {
  const record = JSON.stringify({ id: 'another-room', ts: Date.now() })
  localStorage.setItem(ROOM_PRESENTATION_KEY, record)
  const active = setup('companion'); await nextTick()
  expect(wrapper!.text()).toBe('true')
  active.value = false; await nextTick()
  expect(localStorage.getItem(ROOM_PRESENTATION_KEY)).toBe(record)
  expect(clearInterval).toHaveBeenCalledWith(vi.mocked(window.setInterval).mock.results[0]!.value)
  desktop.active = false
  active.value = true; await nextTick()
  expect(wrapper!.text()).toBe('false')
  expect(localStorage.getItem(ROOM_PRESENTATION_KEY)).toBe(record)
})

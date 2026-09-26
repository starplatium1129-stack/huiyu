import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DesktopTitleBar from './DesktopTitleBar.vue'
import type { CompanionDesktopBridge } from '@/types/desktop'
vi.mock('vue-router', () => ({ useRoute: () => ({ path: '/', meta: { title: '我的工作台' } }) }))
afterEach(() => { desktopFixture.current = undefined; document.documentElement.classList.remove('aics-desktop-shell') })
describe('desktop title bar lifecycle', () => {
  it('does not add desktop controls to a browser', () => {
    const wrapper = mount(DesktopTitleBar)
    expect(wrapper.find('header').exists()).toBe(false)
    wrapper.unmount()
  })
  it('keeps newer window events ahead of a late initial query', async () => {
    let resolve!: (state: { maximized: boolean; focused: boolean }) => void
    let listener!: (maximized: boolean) => void
    const off = vi.fn()
    desktopFixture.current = {
      getWindowState: () => new Promise(done => { resolve = done }),
      onMaximizedChanged: (callback: typeof listener) => { listener = callback; return 0 },
      offMaximizedChanged: off,
    } as unknown as CompanionDesktopBridge
    const wrapper = mount(DesktopTitleBar)
    listener(true)
    resolve({ maximized: false, focused: true })
    await flushPromises()
    expect(wrapper.find('[aria-label="还原"]').exists()).toBe(true)
    wrapper.unmount()
    expect(off).toHaveBeenCalledWith(0)
  })
  it('unsubscribes even if unmounted while a state query is pending', async () => {
    let resolve!: (state: { maximized: boolean; focused: boolean }) => void
    const subscribe = vi.fn(() => 7)
    const off = vi.fn()
    desktopFixture.current = {
      getWindowState: () => new Promise(done => { resolve = done }),
      onMaximizedChanged: subscribe, offMaximizedChanged: off,
    } as unknown as CompanionDesktopBridge
    const wrapper = mount(DesktopTitleBar)
    wrapper.unmount()
    resolve({ maximized: true, focused: true })
    await flushPromises()
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(off).toHaveBeenCalledWith(7)
    expect(document.documentElement.classList.contains('aics-desktop-shell')).toBe(false)
  })
})

const desktopFixture = vi.hoisted(() => ({ current: undefined as CompanionDesktopBridge | undefined }))
vi.mock('@/platform/desktop/capabilities', () => ({ getDesktopCapabilities: () => desktopFixture.current }))

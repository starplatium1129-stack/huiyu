import { mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import AppInteractionLayer from './AppInteractionLayer.vue'

const mocks = vi.hoisted(() => ({ prefetch: vi.fn(), resources: vi.fn(), intent: vi.fn() }))
vi.mock('@/router', () => ({ prefetchRoute: mocks.prefetch, prefetchRouteResources: mocks.resources }))
vi.mock('@/composables/useNavigationFeedback', () => ({
  announceNavigationIntent: mocks.intent,
  useNavigationFeedback: () => ({ loading: false }),
}))
vi.mock('@/composables/useInterfaceFeedback', () => ({ playInterfaceTone: vi.fn() }))

let wrapper: ReturnType<typeof mount> | undefined
const initialUrl = location.href
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined
  document.body.innerHTML = ''
  history.replaceState(null, '', initialUrl)
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks()
})

function setup(mode: string, current: string, href: string) {
  vi.stubEnv('MODE', mode)
  vi.useFakeTimers()
  history.replaceState(null, '', current)
  wrapper = mount(AppInteractionLayer, { attachTo: document.body })
  const link = document.createElement('a')
  link.href = href
  document.body.append(link)
  return link
}

for (const mode of ['desktop', 'test']) {
  const current = mode === 'desktop' ? '/#/style' : '/style'
  const destination = '/scene-explorer?q=%E5%A4%9C#results'
  const href = mode === 'desktop' ? `/#${destination}` : destination

  it(`warms the complete destination on focus and committed pointer intent (${mode})`, () => {
    const link = setup(mode, current, href)
    link.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(mocks.prefetch).toHaveBeenLastCalledWith(destination)
    expect(mocks.resources).not.toHaveBeenCalled()
    link.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    expect(mocks.prefetch).toHaveBeenLastCalledWith(destination)
    expect(mocks.intent).toHaveBeenCalledWith(destination)
    expect(mocks.resources).toHaveBeenCalledWith(destination)
  })

  it(`warms the target module only after hover dwell (${mode})`, () => {
    const link = setup(mode, current, href)
    link.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    vi.advanceTimersByTime(89)
    expect(mocks.prefetch).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(mocks.prefetch).toHaveBeenCalledExactlyOnceWith(destination)
    expect(mocks.resources).not.toHaveBeenCalled()
  })

  it(`ignores the current URL but accepts a query change (${mode})`, () => {
    const link = setup(mode, current, current)
    link.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(mocks.prefetch).not.toHaveBeenCalled()
    link.href = `${current}?tab=colors`
    link.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(mocks.prefetch).toHaveBeenCalledExactlyOnceWith('/style?tab=colors')
  })
}

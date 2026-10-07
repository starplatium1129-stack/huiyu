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

it('ignores non-navigating presses before announcing or fetching and accepts plain Enter', () => {
  const link = setup('test', '/style', '/showcase')
  for (const options of [{ button: 1 }, { button: 2 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) {
    link.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, ...options }))
  }
  for (const options of [{ key: ' ' }, { key: 'Enter', ctrlKey: true }, { key: 'Enter', metaKey: true }, { key: 'Enter', shiftKey: true }, { key: 'Enter', altKey: true }]) {
    link.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...options }))
  }
  const prevented = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  prevented.preventDefault(); link.dispatchEvent(prevented)
  expect(mocks.intent).not.toHaveBeenCalled()
  expect(mocks.resources).not.toHaveBeenCalled()
  expect(mocks.prefetch).not.toHaveBeenCalled()
  link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  expect(mocks.intent).toHaveBeenCalledExactlyOnceWith('/showcase')
  expect(mocks.resources).toHaveBeenCalledExactlyOnceWith('/showcase')
})

it('leaves downloads, external links and other browsing contexts to the browser', () => {
  const link = setup('test', '/style', '/scene-explorer')
  for (const target of ['_blank', '_BLANK', 'reference-window']) {
    link.target = target
    link.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  }
  link.removeAttribute('target'); link.download = 'scenes.json'
  link.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  link.removeAttribute('download'); link.href = 'https://example.com/scene-explorer'
  link.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  expect(mocks.intent).not.toHaveBeenCalled()
  expect(mocks.resources).not.toHaveBeenCalled()
  expect(mocks.prefetch).not.toHaveBeenCalled()
})

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

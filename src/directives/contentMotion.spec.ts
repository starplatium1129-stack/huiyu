import { afterEach, expect, it, vi } from 'vitest'
import type { DirectiveBinding, VNode } from 'vue'
import { contentMotion, installContentMotion } from './contentMotion'
vi.mock('@/utils/motionPreference', () => ({ prefersReducedMotion: () => false }))
const elements: HTMLElement[] = []
function panel() {
  const el = document.createElement('div')
  document.body.append(el); elements.push(el)
  const animation = { cancel: vi.fn(), onfinish: null, oncancel: null } as unknown as Animation
  el.animate = vi.fn(() => animation)
  el.getClientRects = () => { throw new Error('synchronous layout read') }
  el.getAnimations = () => { throw new Error('synchronous animation style read') }
  return { el, animation }
}
function update(el: HTMLElement, value: unknown = 'next') {
  contentMotion.updated!(el, { value, oldValue: 'previous' } as DirectiveBinding, {} as VNode<HTMLElement, HTMLElement>, {} as VNode<HTMLElement, HTMLElement>)
}
afterEach(() => {
  for (const el of elements.splice(0)) { contentMotion.beforeUnmount!(el, {} as DirectiveBinding, {} as VNode<HTMLElement, HTMLElement>, null); el.remove() }
})
it('switches content without reading layout and releases the finished effect', () => {
  const { el, animation } = panel(); update(el)
  expect(el.animate).toHaveBeenCalledOnce()
  animation.onfinish!({} as AnimationPlaybackEvent)
  expect(animation.cancel).toHaveBeenCalledOnce()
})
it('does not start nested effects while the route is entering or a panel is hidden', () => {
  const { el } = panel(); el.dataset.routeEntering = 'true'; update(el)
  delete el.dataset.routeEntering; el.style.display = 'none'; update(el)
  expect(el.animate).not.toHaveBeenCalled()
})
it('settles changing content on keyboard input and resumes feedback on pointer input', () => {
  const stop = installContentMotion()
  try {
    const { el, animation } = panel(); update(el)
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowRight' }))
    expect(animation.cancel).toHaveBeenCalledOnce()
    update(el, 'keyboard selection')
    expect(el.animate).toHaveBeenCalledOnce()
    document.dispatchEvent(new Event('pointerdown'))
    update(el, 'pointer selection')
    expect(el.animate).toHaveBeenCalledTimes(2)
  } finally { stop() }
})
it('hiding or unmounting a changing panel cancels its effect', () => {
  const { el, animation } = panel(); update(el); update(el, false)
  expect(animation.cancel).toHaveBeenCalledOnce()
  update(el); contentMotion.beforeUnmount!(el, {} as DirectiveBinding, {} as VNode<HTMLElement, HTMLElement>, null)
  expect(animation.cancel).toHaveBeenCalledTimes(2)
})

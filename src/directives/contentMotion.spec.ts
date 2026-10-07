import { afterEach, expect, it, vi } from 'vitest'
import type { DirectiveBinding, VNode } from 'vue'
import { contentMotion, installContentMotion } from './contentMotion'
vi.mock('@/utils/motionPreference', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/motionPreference')>(), prefersReducedMotion: () => false,
}))
const elements: HTMLElement[] = []
function panel() {
  const el = document.createElement('div')
  document.body.append(el); elements.push(el)
  const animation = { cancel: vi.fn(), pause:vi.fn(), play:vi.fn(), onfinish: null, oncancel: null } as unknown as Animation
  el.animate = vi.fn(() => animation)
  el.getClientRects = () => { throw new Error('synchronous layout read') }
  el.getAnimations = () => { throw new Error('synchronous animation style read') }
  return { el, animation }
}
function update(el: HTMLElement, value: unknown = 'next', arg?: string) {
  contentMotion.updated!(el, { value, oldValue: 'previous', arg } as DirectiveBinding, {} as VNode<HTMLElement, HTMLElement>, {} as VNode<HTMLElement, HTMLElement>)
}
afterEach(() => {
  vi.unstubAllGlobals()
  for (const el of elements.splice(0)) { contentMotion.beforeUnmount!(el, {} as DirectiveBinding, {} as VNode<HTMLElement, HTMLElement>, null); el.remove() }
})
it('starts a deferred browse arrival after the display and focus patch, and cancels a stale arrival', () => {
  let frame: FrameRequestCallback = () => {}
  const cancelFrame = vi.fn()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 7 })
  vi.stubGlobal('cancelAnimationFrame', cancelFrame)
  const { el } = panel()
  el.style.display = 'none'
  contentMotion.updated!(el, { value:'album', oldValue:false, arg:'fade', modifiers:{defer:true}, instance:null, dir:contentMotion }, {} as VNode<HTMLElement, HTMLElement>, {} as VNode<HTMLElement, HTMLElement>)
  expect(el.animate).not.toHaveBeenCalled()
  el.style.display = ''
  frame(0)
  expect(el.animate).toHaveBeenCalledOnce()
  contentMotion.updated!(el, { value:'next', oldValue:'album', modifiers:{defer:true}, instance:null, dir:contentMotion }, {} as VNode<HTMLElement, HTMLElement>, {} as VNode<HTMLElement, HTMLElement>)
  update(el, false)
  expect(cancelFrame).toHaveBeenCalledWith(7)
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
it('releases an existing content effect when its containing surface becomes inert', () => {
  const { el, animation } = panel(), parent = document.createElement('div')
  document.body.append(parent); parent.append(el)
  try {
    update(el)
    parent.inert = true; update(el, 'hidden update')
    expect(animation.cancel).toHaveBeenCalledOnce()
    expect(el.animate).toHaveBeenCalledOnce()
    parent.inert = false; update(el, 'returned update')
    expect(el.animate).toHaveBeenCalledTimes(2)
  } finally { el.remove(); parent.remove() }
})
it('reveals the native disclosure body on open and keeps its summary still on close', () => {
  const stop = installContentMotion(), details = document.createElement('details'), summary = document.createElement('summary')
  const { el, animation } = panel()
  summary.textContent = '详细信息'; summary.animate = vi.fn(); details.animate = vi.fn()
  el.setAttribute('data-disclosure-content', '')
  details.append(summary, el); document.body.append(details)
  try {
    details.open = true
    expect(el.animate).toHaveBeenCalledOnce()
    expect(summary.animate).not.toHaveBeenCalled(); expect(details.animate).not.toHaveBeenCalled()
    details.open = false
    expect(animation.cancel).toHaveBeenCalledOnce(); expect(el.animate).toHaveBeenCalledOnce()
    el.removeAttribute('data-disclosure-content')
    details.open = true
    expect(el.animate).toHaveBeenCalledTimes(2)
  } finally { stop(); details.remove() }
})
it('settles moving content on keyboard input and keeps keyboard selection feedback still', () => {
  const stop = installContentMotion()
  try {
    const { el, animation } = panel(); update(el)
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowRight' }))
    expect(animation.cancel).toHaveBeenCalledOnce()
    update(el, 'keyboard selection', 'right')
    expect(el.animate).toHaveBeenCalledTimes(2)
    expect(el.animate).toHaveBeenLastCalledWith([{ opacity: '.35' }, { opacity: 1 }], expect.anything())
    document.dispatchEvent(new Event('pointerdown'))
    update(el, 'pointer selection')
    expect(el.animate).toHaveBeenCalledTimes(3)
  } finally { stop() }
})
it('hands a moving surface to its selected child without cancelling unrelated content', () => {
  const stop = installContentMotion()
  const parent = panel(), child = panel(), unrelated = panel()
  const button = document.createElement('button')
  child.el.append(button); parent.el.append(child.el)
  try {
    update(parent.el); update(unrelated.el); update(child.el)
    expect(child.el.animate).not.toHaveBeenCalled()
    button.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(parent.animation.cancel).toHaveBeenCalledOnce()
    expect(unrelated.animation.cancel).not.toHaveBeenCalled()
    update(child.el, 'selected child', 'right')
    expect(child.el.animate).toHaveBeenCalledOnce()
  } finally { stop() }
})
it('hiding or unmounting a changing panel cancels its effect', () => {
  const { el, animation } = panel(); update(el); update(el, false)
  expect(animation.cancel).toHaveBeenCalledOnce()
  update(el); contentMotion.beforeUnmount!(el, {} as DirectiveBinding, {} as VNode<HTMLElement, HTMLElement>, null)
  expect(animation.cancel).toHaveBeenCalledTimes(2)
})
it('redirects a directional handoff from its current presentation', () => {
  const { el } = panel()
  update(el, 'first', 'right')
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({ opacity: '.94', transform: 'matrix(1, 0, 0, 1, 3, 0)' } as CSSStyleDeclaration)
  update(el, 'reverse', 'left')
  expect(el.animate).toHaveBeenLastCalledWith([
    { opacity: '.94', transform: 'matrix(1, 0, 0, 1, 3, 0)' }, { opacity: 1, transform: 'none' },
  ], expect.anything())
  vi.restoreAllMocks()
})
it('keeps an actively edited number input still', () => {
  const input = document.createElement('input'); input.type = 'number'
  document.body.append(input); input.focus()
  input.animate = vi.fn()
  update(input, 7, 'up')
  expect(input.animate).not.toHaveBeenCalled()
  input.remove()
})

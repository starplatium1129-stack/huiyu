import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { useFocusTrap } from './useFocusTrap'
import { useFluidDialog } from './useFluidDialog'

vi.mock('./useFluidSurface', () => ({
  useFluidSurface: () => ({
    enter: (_el: Element, done: () => void) => done(),
    leave: (_el: Element, done: () => void) => done(),
    dispose: vi.fn(),
  }),
}))

const mounted: VueWrapper[] = []

beforeEach(() => {
  // happy-dom has no layout; model rendered boxes without replacing focus or keyboard behavior.
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    for (let el: HTMLElement | null = this; el; el = el.parentElement) {
      if (el.hidden || el.hasAttribute('inert') || getComputedStyle(el).display === 'none') return [] as unknown as DOMRectList
    }
    return [new DOMRect(0, 0, 100, 30)] as unknown as DOMRectList
  })
})

afterEach(() => {
  mounted.splice(0).reverse().forEach(wrapper => wrapper.unmount())
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  document.body.classList.remove('overlay-open')
})

function key(key: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
  document.activeElement?.dispatchEvent(event)
  return event
}

async function mountTrap(content: string, onEscape?: () => void) {
  const open = ref(true)
  const wrapper = mount(defineComponent({ setup() {
    const root = ref<HTMLElement | null>(null)
    useFocusTrap(root, () => open.value, { onEscape })
    return () => h('section', { ref: root, innerHTML: content })
  } }), { attachTo: document.body })
  mounted.push(wrapper)
  await nextTick()
  return { wrapper, open, panel: wrapper.element as HTMLElement }
}

function mountNativeDialog(target: HTMLElement = document.body) {
  let motion!: ReturnType<typeof useFluidDialog>
  const wrapper = mount(defineComponent({ setup() {
    const dialog = ref<HTMLDialogElement | null>(null)
    motion = useFluidDialog(dialog)
    return () => h('dialog', { ref: dialog }, [h('button', 'Native first'), h('button', 'Native last')])
  } }), { attachTo: target })
  mounted.push(wrapper)
  const dialog = wrapper.element as HTMLDialogElement

  // happy-dom's showModal only sets open: model :modal state, not focus or event handling.
  let modal = false
  const showModal = dialog.showModal.bind(dialog)
  vi.spyOn(dialog, 'showModal').mockImplementation(() => { modal = true; showModal() })
  const show = dialog.show.bind(dialog)
  vi.spyOn(dialog, 'show').mockImplementation(() => { modal = false; show() })
  const querySelector = document.querySelector.bind(document)
  vi.spyOn(document, 'querySelector').mockImplementation(selector => selector === 'dialog:modal'
    ? (modal && dialog.open && dialog.isConnected ? dialog : null) : querySelector(selector))
  const closest = Element.prototype.closest
  vi.spyOn(Element.prototype, 'closest').mockImplementation(function (this: Element, selector: string) {
    return selector === 'dialog:modal'
      ? (modal && dialog.open && dialog.contains(this) ? dialog : null) : closest.call(this, selector)
  })
  return { dialog, motion }
}

it('does not close a dialog when Escape belongs to an input method composition', async () => {
  const close = vi.fn()
  const owner = mount(defineComponent({ setup() {
    const root = ref<HTMLElement | null>(null)
    useFocusTrap(root, () => true, { onEscape: close })
    return () => h('section', { ref: root })
  } }), { attachTo: document.body })
  await nextTick()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, cancelable: true }))
  expect(close).not.toHaveBeenCalled()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
  expect(close).toHaveBeenCalledOnce()
  owner.unmount()
})

it('a cached inactive page releases its trap and reacquires it when restored', async () => {
  const active = ref(true), close = vi.fn()
  const Page = defineComponent({ setup() {
    const root = ref<HTMLElement | null>(null)
    useFocusTrap(root, () => true, { onEscape: close })
    return () => h('section', { ref: root })
  } })
  const owner = mount(defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => active.value ? h(Page) : null }) }), { attachTo: document.body })
  await nextTick()
  expect(document.body.classList.contains('overlay-open')).toBe(true)
  active.value = false; await nextTick(); await nextTick()
  expect(document.body.classList.contains('overlay-open')).toBe(false)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
  expect(close).not.toHaveBeenCalled()
  active.value = true; await nextTick(); await nextTick()
  expect(document.body.classList.contains('overlay-open')).toBe(true)
  owner.unmount()
})

it('an initially open empty dialog receives focus and restores the opener on close', async () => {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus()
  const open = ref(true)
  const owner = mount(defineComponent({ setup() {
    const root = ref<HTMLElement | null>(null)
    useFocusTrap(root, () => open.value)
    return () => h('section', { ref: root })
  } }), { attachTo: document.body })
  await nextTick()
  expect(document.activeElement).toBe(owner.element)
  expect(owner.attributes('tabindex')).toBe('-1')
  open.value = false; await nextTick()
  expect(document.activeElement).toBe(opener)
  expect(owner.attributes('tabindex')).toBeUndefined()
  owner.unmount()
})
it('only the top trap handles Escape and closing it preserves the underlying scroll lock', async () => {
  const firstOpen = ref(false), secondOpen = ref(false)
  const firstClose = vi.fn(() => { firstOpen.value = false })
  const secondClose = vi.fn(() => { secondOpen.value = false })
  const owner = mount(defineComponent({ setup() {
    const first = ref<HTMLElement | null>(null), second = ref<HTMLElement | null>(null)
    useFocusTrap(first, () => firstOpen.value, { onEscape: firstClose })
    useFocusTrap(second, () => secondOpen.value, { onEscape: secondClose })
    return () => h('div', [h('section', { ref: first }, [h('button', 'one')]), h('section', { ref: second }, [h('button', 'two')])])
  } }), { attachTo: document.body })
  firstOpen.value = true; await nextTick()
  secondOpen.value = true; await nextTick()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await nextTick()
  expect(secondClose).toHaveBeenCalledOnce()
  expect(firstClose).not.toHaveBeenCalled()
  expect(document.body.classList.contains('overlay-open')).toBe(true)
  owner.unmount()
  expect(document.body.classList.contains('overlay-open')).toBe(false)
})

it('excludes negative tabindex, disabled controls and hidden descendants from both Tab boundaries', async () => {
  const { panel } = await mountTrap(`
    <button tabindex="-1">Programmatic only</button>
    <button tabindex="-2">Also programmatic only</button>
    <button disabled tabindex="0">Disabled</button>
    <div hidden><button>Hidden</button></div>
    <div inert><button>Inert</button></div>
    <div style="display:none"><button>Not rendered</button></div>
    <button style="visibility:hidden">Invisible</button>
    <button id="first">First</button><button id="last">Last</button>
    <button tabindex="-1">Not a Tab boundary</button>
  `)
  const first = panel.querySelector<HTMLElement>('#first')!
  const last = panel.querySelector<HTMLElement>('#last')!
  expect(document.activeElement).toBe(first)
  expect(key('Tab', true).defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(last)
  expect(key('Tab').defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(first)
  expect(key('Tab').defaultPrevented).toBe(false)
})

it('cycles backwards from an initially empty panel after controls are inserted', async () => {
  const { panel } = await mountTrap('')
  panel.innerHTML = '<button>First</button><button>Last</button>'
  expect(key('Tab', true).defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(panel.lastElementChild)
})

it('recalculates Tab boundaries when controls are inserted, disabled or removed', async () => {
  const { panel } = await mountTrap('<button>First</button><button>Last</button>')
  const added = document.createElement('button')
  panel.append(added)
  added.focus()
  key('Tab')
  expect(document.activeElement).toBe(panel.firstElementChild)
  added.disabled = true
  const last = panel.children[1] as HTMLElement
  last.focus()
  key('Tab')
  expect(document.activeElement).toBe(panel.firstElementChild)
  panel.innerHTML = ''
  expect(key('Tab').defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(panel)
})

it('recovers focus immediately when code focuses background content', async () => {
  const outside = document.createElement('button')
  document.body.append(outside)
  const { panel } = await mountTrap('<button>Inside</button>')
  outside.focus()
  expect(document.activeElement).toBe(panel.firstElementChild)
})

it('restores the opener when an open dialog is removed with v-if', async () => {
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  const shown = ref(true)
  const Dialog = defineComponent({ setup() {
    const root = ref<HTMLElement | null>(null)
    useFocusTrap(root, () => true)
    return () => h('section', { ref: root }, h('button', 'Close'))
  } })
  mounted.push(mount(defineComponent({ setup: () => () => shown.value ? h(Dialog) : null }), { attachTo: document.body }))
  await nextTick()
  shown.value = false
  await nextTick()
  expect(document.activeElement).toBe(opener)
  expect(document.body.classList.contains('overlay-open')).toBe(false)
})

it('keeps the top dialog focused when its parent closes, then returns to the original opener', async () => {
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  const parent = await mountTrap('<button>Open nested dialog</button>')
  const child = await mountTrap('<button>Close nested dialog</button>')
  parent.open.value = false
  await nextTick()
  parent.panel.remove()
  expect(document.activeElement).toBe(child.panel.firstElementChild)
  expect(document.body.classList.contains('overlay-open')).toBe(true)
  child.open.value = false
  await nextTick()
  expect(document.activeElement).toBe(opener)
  expect(document.body.classList.contains('overlay-open')).toBe(false)
})

it('preserves an existing external scroll lock after closing', async () => {
  document.body.classList.add('overlay-open')
  const { open } = await mountTrap('<button>Close</button>')
  open.value = false
  await nextTick()
  expect(document.body.classList.contains('overlay-open')).toBe(true)
})

it('leaves handled Escape and legacy composition events to the active control', async () => {
  const close = vi.fn()
  mounted.push(mount(defineComponent({ setup() {
    const root = ref<HTMLElement | null>(null)
    useFocusTrap(root, () => true, { onEscape: close })
    return () => h('section', { ref: root }, h('button', 'Inside'))
  } }), { attachTo: document.body }))
  await nextTick()
  const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
  handled.preventDefault()
  document.dispatchEvent(handled)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, cancelable: true }))
  expect(close).not.toHaveBeenCalled()
})

it('does not attempt to return focus behind a native modal opened through useFluidDialog', async () => {
  const { panel } = await mountTrap('<button>Parent action</button>')
  const { dialog, motion } = mountNativeDialog()
  const parentFocus = vi.spyOn(panel.firstElementChild as HTMLElement, 'focus')
  motion.open()
  const nativeButton = dialog.firstElementChild as HTMLElement
  nativeButton.focus()
  expect(parentFocus).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(nativeButton)
})

it.each([false, true])('yields Tab and Escape to an upper native modal, then resumes after close (descendant: %s)', async (descendant) => {
  const close = vi.fn()
  const { panel } = await mountTrap('<button>Parent first</button><button>Parent last</button>', close)
  const parentFirst = panel.children[0] as HTMLElement
  const parentLast = panel.children[1] as HTMLElement
  const { dialog, motion } = mountNativeDialog(descendant ? panel : document.body)
  motion.open()
  const nativeButton = dialog.lastElementChild as HTMLElement
  nativeButton.focus()
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  nativeButton.dispatchEvent(tab)
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  nativeButton.dispatchEvent(escape)
  expect.soft(tab.defaultPrevented).toBe(false)
  expect.soft(escape.defaultPrevented).toBe(false)
  expect.soft(close).not.toHaveBeenCalled()
  expect(dialog.open).toBe(true)
  expect(document.body.classList.contains('overlay-open')).toBe(true)
  motion.close()
  expect(dialog.open).toBe(false)
  // happy-dom does not perform the browser's return-focus step on close.
  dialog.hidden = true
  parentFirst.focus()
  expect(key('Tab', true).defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(parentLast)
  key('Escape')
  expect(close).toHaveBeenCalledOnce()
})

it('does not suspend a trap for a modeless dialog opened with show()', async () => {
  const close = vi.fn()
  const { panel } = await mountTrap('<button>Parent action</button>', close)
  const { dialog } = mountNativeDialog()
  dialog.show()
  ;(dialog.firstElementChild as HTMLElement).focus()
  expect(document.activeElement).toBe(panel.firstElementChild)
  key('Escape')
  expect(close).toHaveBeenCalledOnce()
})

it('keeps a custom trap inside the active native modal working', async () => {
  const { dialog, motion } = mountNativeDialog()
  motion.open()
  ;(dialog.firstElementChild as HTMLElement).focus()
  const close = vi.fn()
  const { panel } = await mountTrap('<button>Inner first</button><button>Inner last</button>', close)
  dialog.append(panel)
  ;(panel.firstElementChild as HTMLElement).focus()
  expect(key('Tab', true).defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(panel.lastElementChild)
  key('Escape')
  expect(close).toHaveBeenCalledOnce()
})

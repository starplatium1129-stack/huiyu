import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import ConfirmDialog from './ConfirmDialog.vue'
import { confirmAction, resolveConfirm, useConfirmState } from '@/composables/useConfirm'
import { useFocusTrap } from '@/composables/useFocusTrap'

vi.mock('@/composables/useFluidSurface', () => ({
  useFluidSurface: () => ({ enter: (_el: Element, done: () => void) => done(), leave: (_el: Element, done: () => void) => done(), dispose: vi.fn() }),
}))

const mounted: VueWrapper[] = []
const settle = async () => { await nextTick(); await nextTick() }
const button = (kind: 'cancel' | 'confirm') => document.querySelectorAll<HTMLButtonElement>('.confirm-actions button')[kind === 'cancel' ? 0 : 1]!

beforeEach(() => {
  resolveConfirm(false)
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return (this.closest('[inert], [hidden]') ? [] : [new DOMRect(0, 0, 100, 30)]) as unknown as DOMRectList
  })
})

afterEach(() => {
  mounted.splice(0).reverse().forEach(wrapper => wrapper.unmount())
  resolveConfirm(false)
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  document.body.classList.remove('overlay-open')
})

function mountConfirm() {
  const wrapper = mount(ConfirmDialog, { attachTo: document.body })
  mounted.push(wrapper)
  return wrapper
}

it('defaults destructive confirmation to cancel, leaves Enter native, and restores its opener', async () => {
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  mountConfirm()
  const result = confirmAction({ title: '删除作品', danger: true })
  await settle()
  expect(document.activeElement).toBe(button('cancel'))
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  button('cancel').dispatchEvent(enter)
  expect(enter.defaultPrevented).toBe(false)
  expect(useConfirmState().value.visible).toBe(true)
  button('cancel').click()
  await expect(result).resolves.toBe(false)
  await settle()
  expect(document.activeElement).toBe(opener)
})

it('focuses the affirmative option for a non-destructive action', async () => {
  mountConfirm()
  const result = confirmAction({ title: '继续', danger: false })
  await settle()
  expect(document.activeElement).toBe(button('confirm'))
  button('confirm').click()
  await expect(result).resolves.toBe(true)
})

it('takes focus and locks scrolling when mounted with a pending confirmation', async () => {
  const result = confirmAction('删除作品')
  mountConfirm()
  await settle()
  expect(document.activeElement).toBe(button('cancel'))
  expect(document.body.classList.contains('overlay-open')).toBe(true)
  button('cancel').click()
  await expect(result).resolves.toBe(false)
})

it.each([false, true])('resets focus to cancel when a visible request is replaced (previous danger: %s)', async (danger) => {
  mountConfirm()
  const previous = confirmAction({ title: '上一项操作', danger })
  await settle()
  button('confirm').focus()
  const replacement = confirmAction({ title: '删除全部作品', danger: true })
  await settle()
  await expect(previous).resolves.toBe(false)
  expect(document.activeElement).toBe(button('cancel'))
  button('cancel').click()
  await expect(replacement).resolves.toBe(false)
})

it('cycles Tab in both directions and recaptures background focus', async () => {
  const outside = document.createElement('button')
  document.body.append(outside)
  mountConfirm()
  confirmAction('删除作品')
  await settle()
  button('cancel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
  expect(document.activeElement).toBe(button('confirm'))
  button('confirm').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
  expect(document.activeElement).toBe(button('cancel'))
  outside.focus()
  expect(document.activeElement).toBe(button('cancel'))
})

it('closes only the confirmation on Escape and preserves the parent focus trap and scroll lock', async () => {
  mountConfirm()
  const parentClose = vi.fn()
  const parent = mount(defineComponent({ setup() {
    const root = ref<HTMLElement | null>(null)
    useFocusTrap(root, () => true, { onEscape: parentClose })
    return () => h('section', { ref: root }, h('button', 'Delete'))
  } }), { attachTo: document.body })
  mounted.push(parent)
  await settle()
  const opener = parent.get('button').element
  const result = confirmAction('删除作品')
  await settle()
  button('cancel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await expect(result).resolves.toBe(false)
  await settle()
  expect(parentClose).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(opener)
  expect(document.body.classList.contains('overlay-open')).toBe(true)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
  expect(parentClose).toHaveBeenCalledOnce()
})

it('does not consume Escape already handled by a control or an input method', async () => {
  mountConfirm()
  confirmAction('删除作品')
  await settle()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, cancelable: true }))
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, cancelable: true }))
  const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
  handled.preventDefault()
  document.dispatchEvent(handled)
  expect(useConfirmState().value.visible).toBe(true)
})

it('returns focus and safely resolves a pending request when the confirmation host unmounts', async () => {
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  const wrapper = mountConfirm()
  const resolved = vi.fn()
  const result = confirmAction('删除作品').then(resolved)
  await settle()
  wrapper.unmount()
  mounted.splice(mounted.indexOf(wrapper), 1)
  await settle()
  expect(resolved).toHaveBeenCalledWith(false)
  await result
  expect(document.activeElement).toBe(opener)
  expect(document.body.classList.contains('overlay-open')).toBe(false)
})

it('exposes the destructive consequence as the alert dialog description', async () => {
  mountConfirm()
  confirmAction({ title: '删除作品', message: '删除后无法恢复。' })
  await settle()
  const dialog = document.querySelector('[role="alertdialog"]')!
  const description = dialog.getAttribute('aria-describedby')
  expect(description).toBeTruthy()
  expect(document.getElementById(description!)?.textContent).toBe('删除后无法恢复。')
})

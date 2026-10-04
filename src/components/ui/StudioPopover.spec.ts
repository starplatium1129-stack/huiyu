import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, KeepAlive, ref } from 'vue'
import StudioPopover from './StudioPopover.vue'

const mounted: VueWrapper[] = []
afterEach(async () => {
  mounted.splice(0).forEach(wrapper => wrapper.unmount())
  await flushPromises()
  document.body.innerHTML = ''
})

// Native modal dialogs make everything outside their subtree inert. A high z-index
// on a body portal cannot repair this; the popover must stay in the dialog.
it.each(['dialog', 'section'])('keeps popover content inside its %s modal host', async (tag) => {
  const dialog = document.createElement(tag)
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  document.body.append(dialog)
  const wrapper = mount(defineComponent({
    setup() {
      return () => h(StudioPopover, { label: '画室工具' }, {
        trigger: () => h('button', '打开工具'),
        default: () => h('button', '应用工具'),
      })
    },
  }), { attachTo: dialog })
  mounted.push(wrapper)
  await wrapper.get('button').trigger('click')
  await flushPromises()
  const content = document.querySelector('.studio-popover')
  expect(content).not.toBeNull()
  expect(dialog.contains(content)).toBe(true)
  const action = content!.querySelector<HTMLElement>('button')!
  expect(action).not.toBeNull()
  action.focus()
  expect(document.activeElement).toBe(action)
})

it('closes a cached popover without returning focus to its hidden page', async () => {
  const active = ref(true)
  const open = ref(false)
  const Page = defineComponent({ name: 'CachedToolsPage', setup: () => () => h(StudioPopover, {
    label: '画室工具', open: open.value, 'onUpdate:open': (value: boolean) => { open.value = value },
  }, {
    trigger: () => h('button', { class: 'tools-trigger' }, '打开工具'),
    default: () => h('button', '应用工具'),
  }) })
  const Destination = defineComponent({ setup: () => () => h('button', '下一页操作') })
  const owner = mount(defineComponent({ setup: () => () => h(KeepAlive, { include: ['CachedToolsPage'] }, {
    default: () => active.value ? h(Page) : h(Destination),
  }) }), { attachTo: document.body })
  mounted.push(owner)
  const trigger = owner.get<HTMLButtonElement>('.tools-trigger')
  await trigger.trigger('click')
  await flushPromises()
  expect(document.querySelector('.studio-popover')).not.toBeNull()
  const focus = vi.spyOn(trigger.element, 'focus')
  active.value = false
  await flushPromises()
  expect(document.querySelector('.studio-popover')).toBeNull()
  expect(open.value).toBe(false)
  owner.get<HTMLButtonElement>('button').element.focus()
  expect(document.activeElement).toBe(owner.get('button').element)
  expect(focus).not.toHaveBeenCalled()
  active.value = true
  await flushPromises()
  expect(document.querySelector('.studio-popover')).toBeNull()
  await owner.get('.tools-trigger').trigger('click')
  await flushPromises()
  focus.mockClear()
  await owner.get('.tools-trigger').trigger('keydown', { key: 'Escape' })
  await flushPromises()
  expect(document.querySelector('.studio-popover')).toBeNull()
  expect(document.activeElement).toBe(trigger.element)
})

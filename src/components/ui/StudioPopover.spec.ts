import { afterEach, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import StudioPopover from './StudioPopover.vue'

const mounted: VueWrapper[] = []
afterEach(async () => {
  mounted.splice(0).forEach(wrapper => wrapper.unmount())
  await flushPromises()
  document.body.innerHTML = ''
})

// Native modal dialogs make everything outside their subtree inert. A high z-index
// on a body portal cannot repair this; the popover must stay in the dialog.
it('keeps popover content inside its native dialog host', async () => {
  const dialog = document.createElement('dialog')
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

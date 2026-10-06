import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AnimaInpaintModal from './AnimaInpaintModal.vue'

it('retains the same outfit form, draft and scroll position across dismissal and reopen', async () => {
  const previousMotion = document.documentElement.dataset.motion
  document.documentElement.dataset.motion = 'reduce'
  const wrapper = mount(AnimaInpaintModal, {
    props: { open: false, imageSource: { url: null, blob: null, historyId: null } },
    attachTo: document.body,
  })
  try {
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    await wrapper.setProps({ open: true })
    const panel = wrapper.get('[role="dialog"]').element as HTMLElement
    const draft = wrapper.get('textarea')
    await draft.setValue('linen jacket, hand-written outfit draft')
    panel.scrollTop = 120
    await wrapper.setProps({ open: false })
    expect(wrapper.get('.modal-backdrop').isVisible()).toBe(false)
    await wrapper.setProps({ open: true })
    expect(wrapper.get('[role="dialog"]').element).toBe(panel)
    expect(wrapper.get('textarea').element).toBe(draft.element)
    expect((draft.element as HTMLTextAreaElement).value).toBe('linen jacket, hand-written outfit draft')
    expect(panel.scrollTop).toBe(120)
    expect((wrapper.get('.modal-backdrop').element as HTMLElement).inert).toBe(false)
  } finally {
    wrapper.unmount()
    if (previousMotion === undefined) delete document.documentElement.dataset.motion
    else document.documentElement.dataset.motion = previousMotion
  }
})

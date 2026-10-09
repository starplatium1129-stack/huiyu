import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import DirectorMaterialDrawer from './DirectorMaterialDrawer.vue'

describe('drawing material drawer', () => {
  it('respects the application reduced-motion preference when revealing a material', async () => {
    const previous = document.documentElement.dataset.motion
    document.documentElement.dataset.motion = 'reduce'
    const wrapper = mount(DirectorMaterialDrawer, { props: { expert: false } })
    const scroll = vi.spyOn(wrapper.element, 'scrollIntoView').mockImplementation(() => {})
    vi.spyOn(wrapper.element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, -500, 400, 600))
    try {
      await wrapper.vm.selectSection('scenes')
      expect(scroll).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' })
    } finally {
      wrapper.unmount()
      if (previous === undefined) delete document.documentElement.dataset.motion
      else document.documentElement.dataset.motion = previous
    }
  })
  it('keeps a draft input mounted and intact across material switches', async () => {
    const wrapper = mount(DirectorMaterialDrawer, {
      props: { expert: false },
      slots: { story: '<textarea aria-label="draft"></textarea>', character: '<p>Character picker</p>' },
    })
    await wrapper.find('[aria-controls="material-story"]').trigger('click')
    const originalInput = wrapper.find('textarea').element
    await wrapper.find('textarea').setValue('A quiet rainy afternoon')
    await wrapper.find('[aria-controls="material-character"]').trigger('click')
    expect((wrapper.find('#material-story').element as HTMLElement).style.display).toBe('none')
    await wrapper.find('[aria-controls="material-story"]').trigger('click')
    expect(wrapper.find('textarea').element).toBe(originalInput)
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('A quiet rainy afternoon')
  })

  it('returns to an available material when leaving expert history', async () => {
    const wrapper = mount(DirectorMaterialDrawer, { props: { expert: true } })
    await wrapper.find('[aria-controls="material-history"]').trigger('click')
    await wrapper.setProps({ expert: false })
    expect(wrapper.find('[aria-controls="material-history"]').exists()).toBe(false)
    expect(wrapper.find('[aria-controls="material-character"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('#material-character').isVisible()).toBe(true)
  })
})

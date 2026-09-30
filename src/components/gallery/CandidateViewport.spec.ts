import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import CandidateViewport from './CandidateViewport.vue'

it('supports pointer panning and clamps movement and zoom to the image boundary', async () => {
  const wrapper = mount(CandidateViewport, { props: { src: 'blob:fixture', title: 'One', loading: false, pose: { scale: 2, x: 0, y: 0 } } })
  wrapper.element.getBoundingClientRect = () => new DOMRect(0, 0, 200, 200)
  await wrapper.trigger('pointerdown', { button: 0, pointerId: 1, clientX: 50, clientY: 50 })
  await wrapper.trigger('pointermove', { pointerId: 1, clientX: 250, clientY: 0 })
  expect(wrapper.emitted('change')?.at(-1)).toEqual([{ scale: 2, x: .5, y: -.25 }])
  await wrapper.trigger('pointerup', { pointerId: 1 })
  const count = wrapper.emitted('change')!.length
  await wrapper.trigger('pointermove', { pointerId: 1, clientX: 0, clientY: 0 })
  expect(wrapper.emitted('change')).toHaveLength(count)
  await wrapper.trigger('keydown', { key: 'Home' })
  expect(wrapper.emitted('change')?.at(-1)).toEqual([{ scale: 1, x: 0, y: 0 }])
  await wrapper.setProps({ pose: { scale: 4, x: 0, y: 0 } })
  await wrapper.trigger('keydown', { key: '+' })
  expect(wrapper.emitted('change')?.at(-1)).toEqual([{ scale: 4, x: 0, y: 0 }])
  wrapper.unmount()
})

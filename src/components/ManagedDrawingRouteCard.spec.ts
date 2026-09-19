import { afterEach, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ManagedDrawingRouteCard from './ManagedDrawingRouteCard.vue'
import { recommendDrawingRoute } from '@/utils/drawingRoute'

afterEach(() => localStorage.clear())
it.each([0, '0001'])('recipe reuse emits the original stable ID %s', async id => {
  const wrapper = mount(ManagedDrawingRouteCard, { props: {
    route: recommendDrawingRoute({ subjectKind: 'studio', character: 'triad' }),
    subject: { kind: 'studio' }, expert: false, busy: false,
    history: [{ id, character: 'triad', image_id: 'image', sceneTitle: '旧作品' }],
  } })
  await wrapper.findAll('button').find(button => button.text() === '展开详情')!.trigger('click')
  const button = wrapper.findAll('button').find(button => button.text().includes('旧作品'))!
  await button.trigger('click')
  expect(wrapper.emitted('reuse')).toEqual([[id]])
  await wrapper.setProps({ busy: true })
  expect(button.attributes('disabled')).toBeDefined()
  wrapper.unmount()
})


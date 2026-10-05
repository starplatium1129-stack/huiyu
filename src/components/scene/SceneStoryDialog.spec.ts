import { afterEach, expect, it, vi } from 'vitest'
import { DOMWrapper, mount } from '@vue/test-utils'
import SceneStoryDialog from './SceneStoryDialog.vue'

const motion = vi.hoisted(() => ({ finishLeave: () => {}, disposed: vi.fn() }))
vi.mock('@/composables/useFluidSurface', () => ({
  DEFAULT_FLUID_PANEL_SELECTOR: '.story-card',
  useFluidSurface: () => ({
    enter: (_element: Element, done: () => void) => done(),
    leave: (_element: Element, done: () => void) => { motion.finishLeave = done },
    dispose: motion.disposed,
  }),
}))
const wrappers: ReturnType<typeof mount>[] = []
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); motion.disposed.mockClear(); document.body.innerHTML = '' })
const scene = { id: 'story', title: 'A story', story: 'Story text' }
function fixture() {
  const wrapper = mount(SceneStoryDialog, { attachTo: document.body, props: { modelValue: scene }, global: { stubs: {
    transition: false, SceneCard: true, ArchiveIcon: true,
    RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
  } } })
  wrappers.push(wrapper)
  return { wrapper, dom: new DOMWrapper(document.body) }
}

it('retains the story through its exit, then unmounts artwork and opens with a fresh scroll surface', async () => {
  const { wrapper, dom } = fixture()
  const card = dom.get('.story-card').element
  card.scrollTop = 200
  await wrapper.setProps({ modelValue: null })
  expect(dom.get('.story-card h3').text()).toBe(scene.title)
  expect((dom.get('.story-drawer').element as HTMLElement).inert).toBe(true)
  motion.finishLeave()
  await wrapper.vm.$nextTick()
  expect(motion.disposed).toHaveBeenCalledOnce()
  expect(dom.find('.story-card').exists()).toBe(false)
  expect(wrapper.findComponent({ name: 'SceneCard' }).exists()).toBe(false)
  await wrapper.setProps({ modelValue: scene })
  expect(dom.get('.story-card').element).not.toBe(card)
  expect(dom.get('.story-card').element.scrollTop).toBe(0)
})

it('keeps the current story when closing is reversed before the exit completes', async () => {
  const { wrapper, dom } = fixture()
  await wrapper.setProps({ modelValue: null })
  const finishOldLeave = motion.finishLeave
  await wrapper.setProps({ modelValue: { ...scene, id: 'next', title: 'Next story' } })
  finishOldLeave()
  await wrapper.vm.$nextTick()
  expect(dom.get('.story-card h3').text()).toBe('Next story')
  expect((dom.get('.story-drawer').element as HTMLElement).inert).toBe(false)
})

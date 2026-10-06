import { afterEach, expect, it, vi } from 'vitest'
import { DOMWrapper, mount } from '@vue/test-utils'
import SceneStoryDialog from './SceneStoryDialog.vue'

const motion = vi.hoisted(() => ({ finishLeave: () => {}, disposed: vi.fn() }))
vi.mock('@/composables/useFluidSurface', () => ({
  DEFAULT_FLUID_PANEL_SELECTOR: '.viewer-info',
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
    transition: false, ArtworkViewerStage: true, ArchiveIcon: true,
    RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
  } } })
  wrappers.push(wrapper)
  return { wrapper, dom: new DOMWrapper(document.body) }
}

it('retains the story through its exit, then unmounts artwork and opens with a fresh scroll surface', async () => {
  const { wrapper, dom } = fixture()
  const card = dom.get('.viewer-info').element
  card.scrollTop = 200
  await wrapper.setProps({ modelValue: null })
  expect(dom.get('.viewer-title').text()).toBe(scene.title)
  expect(dom.get('.viewer-story').text()).toBe(scene.story)
  expect((dom.get('.art-viewer').element as HTMLElement).inert).toBe(true)
  motion.finishLeave()
  await wrapper.vm.$nextTick()
  expect(motion.disposed).toHaveBeenCalledOnce()
  expect(dom.find('.viewer-info').exists()).toBe(false)
  expect(wrapper.findComponent({ name: 'ArtworkViewerStage' }).exists()).toBe(false)
  await wrapper.setProps({ modelValue: scene })
  expect(dom.get('.viewer-info').element).not.toBe(card)
  expect(dom.get('.viewer-info').element.scrollTop).toBe(0)
})

it('keeps the current story when closing is reversed before the exit completes', async () => {
  const { wrapper, dom } = fixture()
  await wrapper.setProps({ modelValue: null })
  const finishOldLeave = motion.finishLeave
  await wrapper.setProps({ modelValue: { ...scene, id: 'next', title: 'Next story' } })
  finishOldLeave()
  await wrapper.vm.$nextTick()
  expect(dom.get('.viewer-title').text()).toBe('Next story')
  expect((dom.get('.art-viewer').element as HTMLElement).inert).toBe(false)
})

it('uses the artwork stage for scene navigation and keeps R18 out of its neighboring image URLs', async () => {
  const { wrapper } = fixture()
  const next = { id: 'next', title: 'Next story', story: 'Next text' }
  const restricted = { id: 'restricted', title: 'Restricted story', rating: 'R18' }
  await wrapper.setProps({ scenes: [scene, next, restricted] })
  const stage = wrapper.findComponent({ name: 'ArtworkViewerStage' })
  expect(stage.props('original')).toBe(false)
  expect(stage.props('cardUrls')).toEqual({ story: '/scene-showcase/thumbs/story.jpg', next: '/scene-showcase/thumbs/next.jpg' })
  stage.vm.$emit('select', 1)
  await wrapper.vm.$nextTick()
  expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual(next)
  stage.vm.$emit('toggle-original')
  await wrapper.vm.$nextTick()
  expect(stage.props('original')).toBe(true)
})

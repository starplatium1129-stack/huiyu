import { afterEach, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import DirectorStagePanel from './DirectorStagePanel.vue'

const mocks = vi.hoisted(() => ({ interrogate: vi.fn(), cancel: vi.fn() }))
const busy = ref(false)
vi.mock('@/composables/useInterrogate', () => ({
  useInterrogate: () => ({ busy, error: ref(null), ...mocks }),
}))
const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.clearAllMocks(); busy.value = false })
function fixture() {
  const wrapper = mount(DirectorStagePanel, {
    props: {
      displayResultUrl: '/result-a.png', generationBusy: false, generationError: null,
      generationStopped: false, generationStatusText: null, generationProgress: null,
      animaElapsed: 0, animaCurrentNode: '', drawEngine: 'anima', inpaintOriginalUrl: null,
      inpaintCompareActive: false, shotsPending: 0, hasPrevResult: false,
    },
    global: { stubs: {
      CgImageReveal: true, ImageSplitCompare: true, ThinkingOrb: true, BorderBeam: true,
      DirectorResultTools: true, DirectorSceneReference: true, ArchiveIcon: true,
      StudioTooltip: { template: '<span><slot /></span>' },
    } },
  })
  cleanups.push(() => wrapper.unmount())
  return wrapper
}

it('routes current-image reads through the guarded request and cancels on newer artwork', async () => {
  let resolve!: (value: null) => void
  mocks.interrogate.mockImplementation(() => { busy.value = true; return new Promise(done => { resolve = done }) })
  const wrapper = fixture()
  const tools = wrapper.findComponent({ name: 'DirectorResultTools' })
  tools.vm.$emit('interrogateCurrent')
  tools.vm.$emit('interrogateCurrent')
  expect(mocks.interrogate).toHaveBeenCalledExactlyOnceWith('/result-a.png', 'tag', 0.35)
  await wrapper.setProps({ displayResultUrl: '/result-b.png' })
  expect(mocks.cancel).toHaveBeenCalledOnce()
  resolve(null)
  await Promise.resolve()
  expect(wrapper.emitted('interrogateResult')).toBeUndefined()
})

it('cancels in-flight extraction when switching caption/tag engines', async () => {
  const wrapper = fixture()
  await wrapper.setProps({ drawEngine: 'krea2' })
  expect(mocks.cancel).toHaveBeenCalledOnce()
})

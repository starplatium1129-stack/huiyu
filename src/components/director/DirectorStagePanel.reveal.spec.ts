import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import DirectorStagePanel from './DirectorStagePanel.vue'

vi.mock('@/composables/useInterrogate', () => ({
  useInterrogate: () => ({ busy: ref(false), error: ref(null), interrogate: vi.fn(), cancel: vi.fn() }),
}))
const Reveal = defineComponent({
  name: 'CgImageReveal', props: { src: String, autoReveal: Boolean }, emits: ['load', 'reveal-start', 'reveal-complete'],
  setup: () => () => h('div'),
})
const props = {
  displayResultUrl: '/result-a.png', generationBusy: false, generationError: null,
  generationStopped: false, generationStatusText: null, generationProgress: null,
  animaElapsed: 0, animaCurrentNode: '', drawEngine: 'anima', inpaintOriginalUrl: '/original.png',
  inpaintCompareActive: false, hasPrevResult: false,
}
const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).forEach(fn => fn()))
async function fixture(overrides: { resultRevealUrl?: string; displayResultUrl?: string; inpaintCompareActive?: boolean } = {}, loaded = true) {
  const wrapper = mount(DirectorStagePanel, {
    props: { ...props, ...overrides },
    global: { stubs: {
      CgImageReveal: Reveal, ImageSplitCompare: true, ThinkingOrb: true,
      DirectorResultTools: true, DirectorSceneReference: true, ArchiveIcon: true, StudioTooltip: true,
    } },
  })
  cleanup.push(() => wrapper.unmount())
  if (loaded && wrapper.findComponent(Reveal).exists()) {
    wrapper.getComponent(Reveal).vm.$emit('load', { target: { naturalWidth: 832, naturalHeight: 1216 } })
    await nextTick()
  }
  return wrapper
}

describe('result reveal identity', () => {
  it('settles the decoded image ratio before starting the reveal', async () => {
    const wrapper = await fixture({ resultRevealUrl: '/result-a.png' }, false)
    const reveal = wrapper.getComponent(Reveal)
    expect(reveal.props('autoReveal')).toBe(false)
    reveal.vm.$emit('load', { target: { naturalWidth: 1600, naturalHeight: 900 } })
    expect(wrapper.vm.resultAspect).toBe(1600 / 900)
    expect(reveal.props('autoReveal')).toBe(false)
    await nextTick()
    await nextTick()
    expect(reveal.props('autoReveal')).toBe(true)
  })
  it('shows initial and restored history images without a generation signal', async () => {
    const wrapper = await fixture()
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(false)
    await wrapper.setProps({ displayResultUrl: '/unseen-history.png' })
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(false)
  })
  it('does not reveal an unseen history image while a different generation signal remains', async () => {
    const wrapper = await fixture({ resultRevealUrl: '/result-a.png' })
    wrapper.getComponent(Reveal).vm.$emit('reveal-start')
    await wrapper.setProps({ displayResultUrl: '/unseen-history.png' })
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(false)
    await wrapper.setProps({ displayResultUrl: '/result-a.png' })
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(false)
  })
  it('passes a late generation signal to the current image once', async () => {
    const wrapper = await fixture()
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(false)
    await wrapper.setProps({ resultRevealUrl: '/result-a.png' })
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(true)
    wrapper.getComponent(Reveal).vm.$emit('reveal-start')
    await wrapper.setProps({ resultRevealUrl: '' })
    await wrapper.setProps({ resultRevealUrl: '/result-a.png' })
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(false)
  })
  it('does not replay the same result after leaving comparison, even mid-reveal', async () => {
    const wrapper = await fixture({ resultRevealUrl: '/result-a.png' })
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(true)
    wrapper.getComponent(Reveal).vm.$emit('reveal-start')
    await wrapper.setProps({ inpaintCompareActive: true })
    expect(wrapper.findComponent(Reveal).exists()).toBe(false)
    await wrapper.setProps({ inpaintCompareActive: false })
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(false)
  })
  it('does not replay a generated result initially displayed in comparison', async () => {
    const wrapper = await fixture({ resultRevealUrl: '/result-a.png', inpaintCompareActive: true })
    expect(wrapper.findComponent(Reveal).exists()).toBe(false)
    await wrapper.setProps({ inpaintCompareActive: false })
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(false)
  })
  it('consumes a new generation completed while comparison is open', async () => {
    const wrapper = await fixture({ inpaintCompareActive: true })
    await wrapper.setProps({ displayResultUrl: '/result-b.png', resultRevealUrl: '/result-b.png' })
    expect(wrapper.findComponent(Reveal).exists()).toBe(false)
    await wrapper.setProps({ inpaintCompareActive: false })
    expect(wrapper.getComponent(Reveal).props('src')).toBe('/result-b.png')
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(false)
  })
  it('reveals signaled generated results while remembering already viewed history', async () => {
    const wrapper = await fixture({ resultRevealUrl: '/result-a.png' })
    wrapper.getComponent(Reveal).vm.$emit('reveal-complete')
    await wrapper.setProps({ displayResultUrl: '/result-b.png', resultRevealUrl: '/result-b.png' })
    wrapper.getComponent(Reveal).vm.$emit('load', { target: { naturalWidth: 832, naturalHeight: 1216 } })
    await nextTick()
    await nextTick()
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(true)
    wrapper.getComponent(Reveal).vm.$emit('reveal-complete')
    await wrapper.setProps({ displayResultUrl: '/result-a.png', resultRevealUrl: '/result-a.png' })
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(false)
  })
  it('retains the artwork and exposes compact activity while the next result is generating', async () => {
    const wrapper = await fixture()
    await wrapper.setProps({ generationBusy: true })
    expect(wrapper.getComponent(Reveal).props('src')).toBe('/result-a.png')
    expect(wrapper.getComponent({ name: 'DirectorResultTools' }).props('generationBusy')).toBe(true)
  })
})

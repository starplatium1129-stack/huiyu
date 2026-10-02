import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import DirectorStagePanel from './DirectorStagePanel.vue'

vi.mock('@/composables/useInterrogate', () => ({
  useInterrogate: () => ({ busy: ref(false), error: ref(null), interrogate: vi.fn(), cancel: vi.fn() }),
}))
const Reveal = defineComponent({
  name: 'CgImageReveal', props: { src: String, autoReveal: Boolean }, emits: ['reveal-start', 'reveal-complete'],
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
function fixture(overrides: { resultRevealUrl?: string; displayResultUrl?: string; inpaintCompareActive?: boolean } = {}) {
  const wrapper = mount(DirectorStagePanel, {
    props: { ...props, ...overrides },
    global: { stubs: {
      CgImageReveal: Reveal, ImageSplitCompare: true, ThinkingOrb: true,
      DirectorResultTools: true, DirectorResultShelf: true, DirectorSceneReference: true, ArchiveIcon: true, StudioTooltip: true,
    } },
  })
  cleanup.push(() => wrapper.unmount())
  return wrapper
}

describe('result reveal identity', () => {
  it('shows initial and restored history images without a generation signal', async () => {
    const wrapper = fixture()
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(false)
    await wrapper.setProps({ displayResultUrl: '/unseen-history.png' })
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(false)
  })
  it('does not reveal an unseen history image while a different generation signal remains', async () => {
    const wrapper = fixture({ resultRevealUrl: '/result-a.png' })
    wrapper.getComponent(Reveal).vm.$emit('reveal-start')
    await wrapper.setProps({ displayResultUrl: '/unseen-history.png' })
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(false)
    await wrapper.setProps({ displayResultUrl: '/result-a.png' })
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(false)
  })
  it('passes a late generation signal to the current image once', async () => {
    const wrapper = fixture()
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(false)
    await wrapper.setProps({ resultRevealUrl: '/result-a.png' })
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(true)
    wrapper.getComponent(Reveal).vm.$emit('reveal-start')
    await wrapper.setProps({ resultRevealUrl: '' })
    await wrapper.setProps({ resultRevealUrl: '/result-a.png' })
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(false)
  })
  it('does not replay the same result after leaving comparison, even mid-reveal', async () => {
    const wrapper = fixture({ resultRevealUrl: '/result-a.png' })
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(true)
    wrapper.getComponent(Reveal).vm.$emit('reveal-start')
    await wrapper.setProps({ inpaintCompareActive: true })
    expect(wrapper.findComponent(Reveal).exists()).toBe(false)
    await wrapper.setProps({ inpaintCompareActive: false })
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(false)
  })
  it('does not replay a generated result initially displayed in comparison', async () => {
    const wrapper = fixture({ resultRevealUrl: '/result-a.png', inpaintCompareActive: true })
    expect(wrapper.findComponent(Reveal).exists()).toBe(false)
    await wrapper.setProps({ inpaintCompareActive: false })
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(false)
  })
  it('consumes a new generation completed while comparison is open', async () => {
    const wrapper = fixture({ inpaintCompareActive: true })
    await wrapper.setProps({ displayResultUrl: '/result-b.png', resultRevealUrl: '/result-b.png' })
    expect(wrapper.findComponent(Reveal).exists()).toBe(false)
    await wrapper.setProps({ inpaintCompareActive: false })
    expect(wrapper.getComponent(Reveal).props('src')).toBe('/result-b.png')
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(false)
  })
  it('reveals signaled generated results while remembering already viewed history', async () => {
    const wrapper = fixture({ resultRevealUrl: '/result-a.png' })
    wrapper.getComponent(Reveal).vm.$emit('reveal-complete')
    await wrapper.setProps({ displayResultUrl: '/result-b.png', resultRevealUrl: '/result-b.png' })
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(true)
    wrapper.getComponent(Reveal).vm.$emit('reveal-complete')
    await wrapper.setProps({ displayResultUrl: '/result-a.png', resultRevealUrl: '/result-a.png' })
    expect(wrapper.getComponent(Reveal).props('autoReveal')).toBe(false)
  })
  it('retains the artwork and exposes compact activity while the next result is generating', async () => {
    const wrapper = fixture()
    await wrapper.setProps({ generationBusy: true })
    expect(wrapper.getComponent(Reveal).props('src')).toBe('/result-a.png')
    expect(wrapper.get('.stage-result-status').text()).toContain('当前成片保留')
    expect(wrapper.get('.stage-result-status thinking-orb-stub').attributes('size')).toBe('sm')
  })
})

import { afterEach, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import DirectorStagePanel from './DirectorStagePanel.vue'

// This panel fixture does not fetch catalog data or validate its build hash.
vi.mock('virtual:data-version', () => ({ DATA_VERSION: 0 }))

const mocks = vi.hoisted(() => ({ interrogate: vi.fn(), cancel: vi.fn() }))
const busy = ref(false)
vi.mock('@/composables/useInterrogate', () => ({
  useInterrogate: () => ({ busy, error: ref(null), ...mocks }),
}))
const cleanups: Array<() => void> = []
afterEach(async () => {
  await vi.dynamicImportSettled()
  cleanups.splice(0).forEach(fn => fn())
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  busy.value = false
})
function fixture() {
  const wrapper = mount(DirectorStagePanel, {
    props: {
      displayResultUrl: '/result-a.png', generationBusy: false, generationError: null,
      generationStopped: false, generationStatusText: null, generationProgress: null,
      animaElapsed: 0, animaCurrentNode: '', drawEngine: 'anima', inpaintOriginalUrl: null,
      inpaintCompareActive: false, hasPrevResult: false,
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
  void wrapper.vm.interrogateCurrentImage()
  void wrapper.vm.interrogateCurrentImage()
  expect(mocks.interrogate).toHaveBeenCalledExactlyOnceWith('/result-a.png', 'tag')
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

it('exposes the existing extraction cancellation for the shared reference controls', () => {
  const wrapper = fixture()
  wrapper.vm.cancelInterrogate()
  expect(mocks.cancel).toHaveBeenCalledOnce()
})

it('reads a clipboard image on click and reports missing images or denied access', async () => {
  const image = new Blob(['copied image'], { type: 'image/png' })
  const getType = vi.fn().mockResolvedValue(image)
  const read = vi.fn().mockResolvedValue([{ types: ['text/plain'] }, { types: ['image/png'], getType }])
  vi.stubGlobal('navigator', { clipboard: { read } })
  const result = { tags: ['smile'] }
  let copied!: File
  mocks.interrogate.mockImplementation(async (source: () => Promise<File>) => { copied = await source(); return result })
  const wrapper = fixture()
  await wrapper.vm.interrogateClipboardImage()
  expect(read).toHaveBeenCalledOnce()
  expect(getType).toHaveBeenCalledExactlyOnceWith('image/png')
  expect(copied.type).toBe('image/png')
  expect(copied.size).toBe(image.size)
  expect(mocks.interrogate.mock.calls[0][1]).toBe('tag')
  expect(wrapper.emitted('interrogateResult')).toEqual([[result]])
  read.mockResolvedValueOnce([{ types: ['text/plain'] }])
  await wrapper.vm.interrogateClipboardImage()
  expect(wrapper.emitted('interrogateError')?.[0]?.[0]).toContain('剪贴板中没有图片')
  read.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'))
  await wrapper.vm.interrogateClipboardImage()
  expect(wrapper.emitted('interrogateError')?.[1]?.[0]).toContain('未获准读取剪贴板')
  expect(wrapper.emitted('interrogateResult')).toHaveLength(1)
})

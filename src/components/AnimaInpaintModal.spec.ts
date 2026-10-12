import { expect, it } from 'vitest'
import { mount, RouterLinkStub } from '@vue/test-utils'
import AnimaInpaintModal from './AnimaInpaintModal.vue'

it('retains the same outfit form, draft and scroll position across dismissal and reopen', async () => {
  const previousMotion = document.documentElement.dataset.motion
  document.documentElement.dataset.motion = 'reduce'
  const wrapper = mount(AnimaInpaintModal, {
    global: { stubs: { RouterLink: RouterLinkStub } },
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

it('enables native manual masks, rejects empty paint and keeps explicit whole-image choice', async () => {
  const source = new Blob(['image'], { type: 'image/png' })
  const wrapper = mount(AnimaInpaintModal, {
    global: { stubs: { RouterLink: RouterLinkStub } },
    props: { open: true, provider: 'native', imageSource: { url: 'blob:source', blob: source, historyId: null } },
  })
  try {
    const image = wrapper.get('img').element as HTMLImageElement
    Object.defineProperties(image, { naturalWidth: { value: 1000 }, naturalHeight: { value: 700 } })
    await wrapper.get('img').trigger('load')
    await wrapper.get('textarea').setValue('blue jacket')
    const submit = wrapper.get('.btn-submit-inpaint')
    expect(submit.attributes('disabled')).toBeUndefined()
    await submit.trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(wrapper.emitted('submit')).toBeUndefined()
    expect(wrapper.find('#maskPromptInput').exists()).toBe(false)
    expect(wrapper.find('input[aria-label="遮罩边缘羽化外扩"]').exists()).toBe(true)
    const maskButtons = wrapper.findAll('[aria-label="遮罩模式"] button')
    expect(maskButtons).toHaveLength(2)
    expect(maskButtons[0].attributes('disabled')).toBeUndefined()
    expect(maskButtons[0].attributes('aria-pressed')).toBe('true')
    expect(maskButtons[1].attributes('disabled')).toBeDefined()
    expect((wrapper.get('canvas').element as HTMLCanvasElement).width).toBe(1000)
    const wholeButton = wrapper.findAll('button').find(button => button.text().includes('选择整图重绘'))!
    await wholeButton.trigger('click')
    expect(wrapper.text()).toContain('人物、面部和背景均可能变化')
    expect(submit.attributes('disabled')).toBeUndefined()
    await submit.trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(wrapper.emitted('submit')?.[0]?.[0]).toMatchObject({ editMode: 'whole', imageBlob: source, maskBlob: null })
  } finally { wrapper.unmount() }
})

it('gates native automatic recognition on local readiness and retains the choice when readiness is lost', async () => {
  const source = new Blob(['image'], { type: 'image/png' })
  const wrapper = mount(AnimaInpaintModal, {
    global: { stubs: { RouterLink: RouterLinkStub } },
    props: { open: true, provider: 'native', automaticMaskAvailable: false, imageSource: { url: 'blob:source', blob: source, historyId: null } },
  })
  try {
    const image = wrapper.get('img').element as HTMLImageElement
    Object.defineProperties(image, { naturalWidth: { value: 1000 }, naturalHeight: { value: 700 } })
    await wrapper.get('img').trigger('load')
    await wrapper.get('textarea').setValue('blue jacket')
    const automatic = wrapper.findAll('[aria-label="遮罩模式"] button')[1]
    expect(automatic.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('clipseg-rd64-refined')
    await wrapper.setProps({ automaticMaskAvailable: true })
    expect(automatic.attributes('disabled')).toBeUndefined()
    await automatic.trigger('click')
    await wrapper.get('#maskPromptInput').setValue('jacket | sleeves')
    await wrapper.get('.btn-submit-inpaint').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(wrapper.emitted('submit')?.[0]?.[0]).toMatchObject({ editMode: 'masked', maskBlob: null, maskPrompt: 'jacket | sleeves' })
    await wrapper.setProps({ automaticMaskAvailable: false })
    expect(automatic.attributes('aria-pressed')).toBe('true')
    await wrapper.get('.btn-submit-inpaint').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(wrapper.emitted('submit')).toHaveLength(1)
  } finally { wrapper.unmount() }
})


it('keeps Comfy automatic masks unavailable until registered and offers the existing setup route', async () => {
  const wrapper = mount(AnimaInpaintModal, {
    global: { stubs: { RouterLink: RouterLinkStub } },
    props: { open: true, provider: 'comfy', automaticMaskAvailable: false,
      automaticMaskStatus: { state: 'missing', required: ['AP_CLIPSeg_TextMask'], missing: ['AP_CLIPSeg_TextMask'] },
      imageSource: { url: null, blob: null, historyId: null } },
  })
  try {
    const [manual, automatic] = wrapper.findAll('[aria-label="遮罩模式"] button')
    expect(manual.attributes('disabled')).toBeUndefined()
    expect(manual.attributes('aria-pressed')).toBe('true')
    expect(automatic.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('AP_CLIPSeg_TextMask')
    expect(wrapper.text()).toContain('一键准备包不包含')
    expect(wrapper.getComponent(RouterLinkStub).props('to')).toEqual({ path: '/control', query: { engine: 'anima' } })
    await wrapper.setProps({ automaticMaskAvailable: true, automaticMaskStatus: { state: 'ready', required: ['AP_CLIPSeg_TextMask'], missing: [] } })
    expect(automatic.attributes('disabled')).toBeUndefined()
    await automatic.trigger('click')
    await wrapper.get('#maskPromptInput').setValue('jacket')
    expect(wrapper.text()).toContain('不代表其模型文件、加载或识别效果已验证')
    await wrapper.setProps({ automaticMaskAvailable: false, automaticMaskStatus: { state: 'unknown', required: ['AP_CLIPSeg_TextMask'], missing: [] } })
    expect(automatic.attributes('aria-pressed')).toBe('true')
    expect(wrapper.text()).toContain('尚未确认')
    expect(manual.attributes('disabled')).toBeUndefined()
  } finally { wrapper.unmount() }
})


it('allows explicit automatic selection for an offline managed service without claiming registered nodes', async () => {
  const source = new Blob(['image'], { type: 'image/png' })
  const wrapper = mount(AnimaInpaintModal, {
    global: { stubs: { RouterLink: RouterLinkStub } },
    props: { open: true, provider: 'comfy', managedStartAvailable: true, automaticMaskAvailable: false,
      automaticMaskStatus: { state: 'unknown', required: ['AP_CLIPSeg_TextMask'], missing: [] },
      imageSource: { url: 'blob:source', blob: source, historyId: null } },
  })
  try {
    const image = wrapper.get('img').element as HTMLImageElement
    Object.defineProperties(image, { naturalWidth: { value: 832 }, naturalHeight: { value: 1216 } })
    await wrapper.get('img').trigger('load')
    const [manual, automatic] = wrapper.findAll('[aria-label="遮罩模式"] button')
    expect(manual.attributes('aria-pressed')).toBe('true')
    expect(automatic.attributes('disabled')).toBeUndefined()
    expect(wrapper.text()).toContain('启动受管服务并检查节点')
    expect(wrapper.text()).not.toContain('文字自动蒙版节点已注册')
    await automatic.trigger('click')
    await wrapper.get('#maskPromptInput').setValue('jacket')
    await wrapper.get('.btn-submit-inpaint').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(wrapper.emitted('submit')?.[0]?.[0]).toMatchObject({ maskPrompt: 'jacket', maskBlob: null })
    await wrapper.setProps({ automaticMaskStatus: { state: 'missing', required: ['AP_CLIPSeg_TextMask'], missing: ['AP_CLIPSeg_TextMask'] } })
    expect(automatic.attributes('disabled')).toBeDefined()
    await wrapper.get('.btn-submit-inpaint').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(wrapper.emitted('submit')).toHaveLength(1)
  } finally { wrapper.unmount() }
})

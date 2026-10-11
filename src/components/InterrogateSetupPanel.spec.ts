import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { apiClient } from '@/api/client'
import InterrogateSetupPanel from './InterrogateSetupPanel.vue'
import DirectorImageTools from './director/DirectorImageTools.vue'

const status = (ready: boolean) => ({ ok: true, local: true, defaultEngine: 'pixai', pixai: {
  engine: 'pixai', model: 'pixai-tagger-v1.0', available: ready, modelPresent: ready, dependencyPresent: ready,
  reason: ready ? null : 'PixAI Python 或模型依赖未安装',
} })
afterEach(() => { vi.restoreAllMocks() })

it('shows the exact missing resources in control, and rechecks without downloading or loading a model', async () => {
  const request = vi.spyOn(apiClient, 'request').mockResolvedValueOnce(status(false)).mockResolvedValueOnce(status(true))
  const wrapper = mount(InterrogateSetupPanel)
  try {
    await flushPromises()
    expect(wrapper.get('section').attributes('aria-labelledby')).toBe('interrogate-setup-title')
    expect(wrapper.get('#interrogate-setup-title').text()).toBe('PixAI 图片反推')
    expect(wrapper.get('[role="status"]').text()).toContain('缺少完整 PixAI')
    expect(wrapper.get('[role="status"]').text()).toContain('timm 或 Torch')
    expect(wrapper.text()).toContain('桌面版暂没有反推一键准备按钮')
    expect(wrapper.text()).toContain('models:prepare-pixai --plan')
    await wrapper.get('button').trigger('click'); await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('实际加载、CUDA 与反推效果仍需在使用时验证')
    expect(request).toHaveBeenCalledTimes(2)
    for (const call of request.mock.calls) expect(call).toEqual(['/api/interrogate/status', expect.objectContaining({ cachePolicy: 'bypass' })])
  } finally { wrapper.unmount() }
})

it('checks PixAI when the image tools open, blocks missing resources and links the actual control section', async () => {
  const request = vi.spyOn(apiClient, 'request').mockResolvedValue(status(false))
  const wrapper = mount(DirectorImageTools, { props: { generationBusy: false, interrogateBusy: false, interrogateMode: 'tag',
    interrogateError: null, displayResultUrl: '', drawEngine: 'anima', inpaintOriginalUrl: null, inpaintCompareActive: false, shotsPending: 0 },
    global: { stubs: { RouterLink: RouterLinkStub, StudioTooltip: { template: '<span><slot /></span>' } } } })
  try {
    expect(request).not.toHaveBeenCalled()
    const section = wrapper.get('.reference-interrogate')
    ;(section.element as HTMLDetailsElement).open = true
    await section.trigger('toggle'); await flushPromises()
    const upload = wrapper.findAll('button').find(button => button.text() === '上传反推')!
    expect(upload.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('缺少完整 PixAI')
    expect(wrapper.getComponent(RouterLinkStub).props('to')).toEqual({ path: '/control', hash: '#control-interrogate' })
    expect(wrapper.text()).toContain('局部换装需在换装窗口导入原图')
    request.mockResolvedValue(status(true))
    await wrapper.findAll('button').find(button => button.text() === '重新检查反推条件')!.trigger('click'); await flushPromises()
    expect(upload.attributes('disabled')).toBeUndefined()
    await upload.trigger('click')
    expect(wrapper.emitted('interrogateUpload')).toHaveLength(1)
  } finally { wrapper.unmount() }
})

import { expect, it, vi } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import PromptInspectorRender from './PromptInspectorRender.vue'
import type { PromptRenderBindings } from '@/composables/prompt/promptPanelBindings'

it('keeps failure recovery accessible in scene mode and blocks retry while generating', async () => {
  const retryAnima = vi.fn()
  const generationBusy = ref(false)
  const animaState = ref({
    models: [], modelId: 'anima', errorMsg: '', currentNode: 'KSampler', progressText: '连接暂时中断，正在重新读取任务进度…',
    errorReport: { title: '连接中断', message: '请检查绘图服务后重试', details: 'Connection closed' } as { title: string; message: string; details: string } | null,
  })
  const bindings = {
    pb: { directorMode: 'basic', char: 'nene', isPopular: false, visualDescription: '', sdParams: {}, markParamTouched: vi.fn() },
    drawEngine: ref('anima'), generationBusy, animaState, managedRoute: ref(null),
    sdQueue: { canEnqueue: ref(false) }, engineTitle: () => '', retryAnima,
  } as unknown as PromptRenderBindings
  const wrapper = shallowMount(PromptInspectorRender, {
    props: { bindings }, global: {
      directives: { contentMotion: {} },
      stubs: { CasualCreativeSliders: true, GenerationOutputControls: true, ManagedDrawingRouteCard: true, AnimaQuickPanel: true },
    },
  })
  try {
    expect(wrapper.get('[role="alert"]').text()).toContain('请检查绘图服务后重试')
    expect(wrapper.find('.inspector-advanced[open]').exists()).toBe(false)
    expect(wrapper.get('.anima-retry').element.closest('details')).toBeNull()
    await wrapper.get('.anima-retry').trigger('click')
    expect(retryAnima).toHaveBeenCalledOnce()
    generationBusy.value = true
    await nextTick()
    expect(wrapper.get('.anima-retry').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.inspector-runtime').text()).toContain('KSampler')
    expect(wrapper.get('.inspector-runtime').text()).toContain('正在重新读取任务进度')
    await wrapper.get('.anima-retry').trigger('click')
    expect(retryAnima).toHaveBeenCalledOnce()
    animaState.value.errorReport = null
    await nextTick()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  } finally { wrapper.unmount() }
})

import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { RouterLink } from 'vue-router'
import AnimaQuickPanel from './AnimaQuickPanel.vue'
import ToggleSwitch from './visual/ToggleSwitch.vue'
import type { AnimaGenerationState } from '@/types/anima'
import StudioSelect from './ui/StudioSelect.vue'
import { nativeAnimaRequestBlocker } from '@/composables/generation/nativeAnimaCapabilities'

it('adversarial TeaCache keeps auto available with missing files while preserving unsupported hires blocking', async () => {
  const state = { provider: 'native', phase: 'idle', family: 'anima', modelId: 'native-model',
    models: [{ id: 'native-model', capabilities: { hires: false, teaCache: false } }], loras: [],
    width: 832, height: 1216, steps: 30, cfg: 4.5, teaCache: false, hiresFix: false,
  } as unknown as AnimaGenerationState
  const wrapper = mount(AnimaQuickPanel, { props: { state } })
  try {
    expect(wrapper.findAllComponents(ToggleSwitch).map(toggle => toggle.props('disabled'))).toEqual([false, true])
    await wrapper.setProps({ state: { ...state, teaCache: true, hiresFix: true } })
    const toggles = wrapper.findAllComponents(ToggleSwitch)
    expect(toggles.map(toggle => toggle.props('disabled'))).toEqual([false, false])
    toggles[0].vm.$emit('update:modelValue', false)
    toggles[1].vm.$emit('update:modelValue', false)
    expect(wrapper.emitted('update:state')).toEqual([[{ teaCache: false, teaCacheThresh: undefined }], [{ hiresFix: false }]])
  } finally { wrapper.unmount() }
})

it('admits native hires with TeaCache for whole-operation calibration while respecting upscaler readiness', async () => {
  const model = { id: 'native-model', capabilities: { hires: true, hiresUpscalers: ['Auto', 'Latent'], teaCache: true, weightSyntax: true },
    teaCacheProfile: { readiness: 'profile-files-only' } }
  const state = { provider: 'native', phase: 'idle', family: 'anima', modelId: model.id, models: [model], loras: [],
    width: 832, height: 1216, steps: 30, cfg: 4.5, teaCache: false, hiresFix: true } as unknown as AnimaGenerationState
  const wrapper = mount(AnimaQuickPanel, { props: { state } })
  try {
    expect(wrapper.findAllComponents(ToggleSwitch).map(toggle => toggle.props('disabled'))).toEqual([false, false])
    const select = wrapper.findAllComponents(StudioSelect).find(select => select.props('label') === '放大方式')!
    expect(select.props('options')).toContainEqual({ value: 'Remacri', label: 'Remacri', disabled: true })
    await wrapper.setProps({ state: { ...state, teaCache: true, hiresFix: false } })
    expect(wrapper.findAllComponents(ToggleSwitch).map(toggle => toggle.props('disabled'))).toEqual([false, false])
    expect(nativeAnimaRequestBlocker(state.models, { modelId: model.id, hiresFix: true, teaCache: true })).toBeNull()
    expect(nativeAnimaRequestBlocker(state.models, { modelId: model.id, hiresFix: true, hiresUpscaler: 'Remacri' })).toContain('文件未就绪')
    expect(nativeAnimaRequestBlocker(state.models, { modelId: model.id, prompt: '(red coat:1.2)', negative: '[blue sky] BREAK' })).toBeNull()
    expect(nativeAnimaRequestBlocker(state.models, { modelId: model.id, prompt: String.raw`rossi \(arknights\)`, hiresFix: true, hiresUpscaler: 'Latent' })).toBeNull()
  } finally { wrapper.unmount() }
})

it('adversarial TeaCache clears stale thresholds on automatic activation without requiring a profile file', async () => {
  const state = { provider: 'native', phase: 'idle', family: 'anima', modelId: 'native-model',
    models: [{ id: 'native-model', capabilities: { teaCache: true }, teaCacheProfile: { readiness: 'profile-files-only' } }], loras: [],
    width: 832, height: 1216, steps: 30, cfg: 4.5, hiresFix: false,
  } as unknown as AnimaGenerationState
  const wrapper = mount(AnimaQuickPanel, { props: { state } })
  try {
    const toggle = wrapper.findAllComponents(ToggleSwitch)[0]
    expect(toggle.props()).toMatchObject({ modelValue: true, disabled: false })
    expect(wrapper.text()).toContain('未匹配时照常生成')
    expect(wrapper.emitted('update:state')).toBeUndefined()
    toggle.vm.$emit('update:modelValue', true)
    expect(wrapper.emitted('update:state')).toEqual([[{ teaCache: undefined, teaCacheThresh: undefined }]])
    await wrapper.setProps({ state: { ...state, teaCache: true, teaCacheThresh: 0.1 } })
    expect(wrapper.text()).toContain('已保存的阈值 0.1')
    const reset = wrapper.findAll('button').find(button => button.text() === '使用本地校准档阈值')!
    await reset.trigger('click')
    expect(wrapper.emitted('update:state')?.at(-1)).toEqual([{ teaCacheThresh: undefined }])
    await wrapper.setProps({ state: { ...state, models: [{ id: 'native-model', capabilities: state.models[0].capabilities }] } })
    expect(toggle.props('disabled')).toBe(false)
    expect(nativeAnimaRequestBlocker(state.models, { modelId: state.modelId })).toBeNull()
  } finally { wrapper.unmount() }
})

it('shows confirmed Comfy Auto paths without treating unknown resources as Latent', async () => {
  const state = { provider: 'comfy', phase: 'idle', family: 'anima', modelId: 'anima-base-v1.0',
    models: [], loras: [], width: 832, height: 1216, steps: 30, cfg: 4.5,
    hiresFix: true, hiresUpscaler: 'Auto', hiresDenoise: 0.4,
  } as unknown as AnimaGenerationState
  const wrapper = mount(AnimaQuickPanel, { props: { state } })
  try {
    const denoise = () => wrapper.get<HTMLInputElement>('input[id$="-denoise"]')
    const select = wrapper.findAllComponents(StudioSelect).find(item => item.props('label') === '放大方式')!
    expect(select.props('options')).toContainEqual({ value: 'Latent', label: 'Latent · 二次重绘' })
    expect(wrapper.text()).toContain('Auto 放大路径待确认')
    expect(wrapper.get<HTMLInputElement>('input[id$="-strength"]').element.disabled).toBe(false)
    expect(denoise().element.disabled).toBe(true)
    await wrapper.setProps({ state: { ...state, autoHiresModel: '4x_foolhardy_Remacri.safetensors' } })
    expect(wrapper.text()).toContain('普通出图采用像素放大（4x_foolhardy_Remacri.safetensors）')
    expect(denoise().element.disabled).toBe(true)
    expect(denoise().element.value).toBe('0.4')
    expect(wrapper.emitted('update:state')).toBeUndefined()
    await wrapper.setProps({ state: { ...state, autoHiresModel: null } })
    expect(wrapper.text()).toContain('普通出图采用 Latent 二次重绘')
    expect(denoise().element.disabled).toBe(false)
    select.vm.$emit('update:modelValue', 'Latent')
    expect(wrapper.emitted('update:state')).toEqual([[{ hiresUpscaler: 'Latent' }]])
    await wrapper.setProps({ state: { ...state, hiresUpscaler: 'Latent' } })
    expect(denoise().element.disabled).toBe(false)
    await denoise().setValue('0.3')
    expect(wrapper.emitted('update:state')?.at(-1)).toEqual([{ hiresDenoise: 0.3 }])
    await wrapper.setProps({ state: { ...state } })
    expect(wrapper.text()).toContain('Auto 放大路径待确认')
    expect(denoise().element.disabled).toBe(true)
  } finally { wrapper.unmount() }
})

it('links unavailable Krea to its environment scope without promising extension installation', () => {
  const state = { provider: 'comfy', phase: 'idle', family: 'krea2', modelId: 'krea2-turbo-fp8',
    models: [], loras: [], online: false, checkMsg: 'Krea 2 缺少 ComfyUI 节点：ComfyUI-Krea2T-Enhancer。',
    width: 1024, height: 1024, steps: 12, cfg: 1,
  } as unknown as AnimaGenerationState
  const wrapper = mount(AnimaQuickPanel, { props: { state }, global: { stubs: { RouterLink: true } } })
  try {
    expect(wrapper.text()).toContain('ComfyUI-Krea2T-Enhancer')
    expect(wrapper.getComponent(RouterLink).props('to')).toEqual({ path: '/control', query: { engine: 'krea2' } })
    expect(wrapper.emitted('update:state')).toBeUndefined()
  } finally { wrapper.unmount() }
})

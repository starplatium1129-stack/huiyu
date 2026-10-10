import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AnimaQuickPanel from './AnimaQuickPanel.vue'
import ToggleSwitch from './visual/ToggleSwitch.vue'
import type { AnimaGenerationState } from '@/types/anima'

it('prevents enabling native unsupported features but lets the user clear restored selections', async () => {
  const state = { provider: 'native', phase: 'idle', family: 'anima', modelId: 'native-model',
    models: [{ id: 'native-model', capabilities: { hires: false, teaCache: false } }], loras: [],
    width: 832, height: 1216, steps: 30, cfg: 4.5, teaCache: false, hiresFix: false,
  } as unknown as AnimaGenerationState
  const wrapper = mount(AnimaQuickPanel, { props: { state } })
  try {
    expect(wrapper.findAllComponents(ToggleSwitch).map(toggle => toggle.props('disabled'))).toEqual([true, true])
    await wrapper.setProps({ state: { ...state, teaCache: true, hiresFix: true } })
    const toggles = wrapper.findAllComponents(ToggleSwitch)
    expect(toggles.map(toggle => toggle.props('disabled'))).toEqual([false, false])
    toggles[0].vm.$emit('update:modelValue', false)
    toggles[1].vm.$emit('update:modelValue', false)
    expect(wrapper.emitted('update:state')).toEqual([[{ teaCache: false, teaCacheThresh: undefined }], [{ hiresFix: false }]])
  } finally { wrapper.unmount() }
})

it('offers explicit experimental native activation only for local profile files and clears legacy thresholds on user choice', async () => {
  const state = { provider: 'native', phase: 'idle', family: 'anima', modelId: 'native-model',
    models: [{ id: 'native-model', capabilities: { teaCache: true }, teaCacheProfile: { readiness: 'profile-files-only' } }], loras: [],
    width: 832, height: 1216, steps: 30, cfg: 4.5, hiresFix: false,
  } as unknown as AnimaGenerationState
  const wrapper = mount(AnimaQuickPanel, { props: { state } })
  try {
    const toggle = wrapper.findAllComponents(ToggleSwitch)[0]
    expect(toggle.props()).toMatchObject({ modelValue: false, disabled: false })
    expect(wrapper.text()).toContain('速度与画质尚未验收')
    expect(wrapper.emitted('update:state')).toBeUndefined()
    toggle.vm.$emit('update:modelValue', true)
    expect(wrapper.emitted('update:state')).toEqual([[{ teaCache: true, teaCacheThresh: undefined }]])
    await wrapper.setProps({ state: { ...state, teaCache: true, teaCacheThresh: 0.1 } })
    expect(wrapper.text()).toContain('已保存的阈值 0.1')
    const reset = wrapper.findAll('button').find(button => button.text() === '使用本地校准档阈值')!
    await reset.trigger('click')
    expect(wrapper.emitted('update:state')?.at(-1)).toEqual([{ teaCacheThresh: undefined }])
    await wrapper.setProps({ state: { ...state, models: [{ id: 'native-model', capabilities: state.models[0].capabilities }] } })
    expect(toggle.props('disabled')).toBe(true)
  } finally { wrapper.unmount() }
})

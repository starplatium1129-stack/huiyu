import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import { reactive } from 'vue'
import GenerationParamsPanel from './GenerationParamsPanel.vue'
import type { SDParams } from '@/utils/promptBuilderPersistence'

it('steps existing SD values within bounds while retaining direct input and slider control', async () => {
  const params = reactive({ cfg: 6.5, steps: 28, sampler: 'Euler', scheduler: '', quality: true,
    negative: false, negativeCustom: '', seed: -1, seedLock: false } as SDParams)
  const wrapper = mount(GenerationParamsPanel, { props: { params, samplers: [], schedulers: [], resultSeed: null }, attrs: { open: true }, attachTo: document.body })
  const cfg = wrapper.get<HTMLInputElement>('input[type="number"][step="0.5"]')
  const original = cfg.element
  await wrapper.get('[aria-label="增加相关性 (CFG)"]').trigger('click')
  expect(params.cfg).toBe(7)
  await wrapper.get('[aria-label="减少相关性 (CFG)"]').trigger('click')
  expect(params.cfg).toBe(6.5)
  cfg.element.focus()
  await cfg.setValue('4.257'); await cfg.trigger('change')
  expect(params.cfg).toBe(4.257)
  expect(wrapper.get('input[step="0.5"]').element).toBe(original)
  expect(document.activeElement).toBe(original)
  await wrapper.get('[aria-label="增加相关性 (CFG)"]').trigger('click')
  expect(params.cfg).toBe(4.757)
  await wrapper.get('input[aria-label="相关性 (CFG) 滑块"]').setValue('20')
  expect(params.cfg).toBe(20)
  expect(wrapper.get('[aria-label="增加相关性 (CFG)"]').attributes('aria-disabled')).toBe('true')
  const touches = wrapper.emitted('touch')!.length
  await wrapper.get('[aria-label="增加相关性 (CFG)"]').trigger('click')
  expect(wrapper.emitted('touch')).toHaveLength(touches)
  await cfg.setValue('1'); await cfg.trigger('change')
  await wrapper.get('[aria-label="减少相关性 (CFG)"]').trigger('click')
  expect(params.cfg).toBe(1)
  const steps = wrapper.get<HTMLInputElement>('input[type="number"][max="150"]')
  await steps.setValue('149'); await steps.trigger('change')
  const increase = wrapper.get<HTMLButtonElement>('[aria-label="增加步数 (Steps)"]')
  increase.element.focus(); await increase.trigger('click')
  expect(params.steps).toBe(150)
  expect(document.activeElement).toBe(increase.element)
  await increase.trigger('click')
  expect(params.steps).toBe(150)
  await wrapper.get('[aria-label="减少步数 (Steps)"]').trigger('click')
  expect(params.steps).toBe(149)
  await wrapper.get('input[aria-label="采样步数滑块"]').setValue('1')
  await wrapper.get('[aria-label="减少步数 (Steps)"]').trigger('click')
  expect(params.steps).toBe(1)
  expect(wrapper.emitted('touch')?.flat()).toContain('steps')
  wrapper.unmount()
})

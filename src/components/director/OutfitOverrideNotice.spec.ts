import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import OutfitOverrideNotice from './OutfitOverrideNotice.vue'

beforeEach(() => setActivePinia(createPinia()))

describe('OutfitOverrideNotice', () => {
  it('shows Chinese outfit labels and restores the default without mutating prompt tokens', async () => {
    const pb = usePromptBuilderStore()
    const tokens = ['panties', 'high_heels', 'underwear']
    pb.setOutfitOverride(tokens, '校服/水手服')
    const wrapper = mount(OutfitOverrideNotice)
    await vi.dynamicImportSettled()
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('已换装为「内裤、高跟鞋、内衣」')
    expect(pb.outfitOverride?.tokens).toEqual(tokens)
    await wrapper.get('button').trigger('click')
    expect(pb.outfitOverride).toBeNull()
    expect(tokens).toEqual(['panties', 'high_heels', 'underwear'])
    wrapper.unmount()
  })

  it('keeps the notice readable for unknown labels', async () => {
    const pb = usePromptBuilderStore()
    pb.setOutfitOverride(['unknown_clothing'], null)
    const wrapper = mount(OutfitOverrideNotice)
    await vi.dynamicImportSettled()
    await flushPromises()
    expect(wrapper.get('.outfit-override-text').text()).toBe('已换装为「新服装」')
    expect(wrapper.get('button').text()).toBe('恢复默认服装')
    wrapper.unmount()
  })
})

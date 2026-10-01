import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import DirectorTagWorkbench from './DirectorTagWorkbench.vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { UNIVERSAL_WARDROBE_PRESETS } from '@/config/universalWardrobe'

const mocks = vi.hoisted(() => ({
  confirmAction: vi.fn(),
  interrogate: vi.fn(),
}))

vi.mock('@/composables/useConfirm', () => ({
  confirmAction: mocks.confirmAction,
}))

vi.mock('@/composables/useInterrogate', () => ({
  useInterrogate: () => ({
    busy: { value: false },
    error: { value: '' },
    interrogate: mocks.interrogate,
  }),
}))

const tooltipStub = { template: '<span><slot /></span>' }
const iconStub = { template: '<svg></svg>' }

describe('DirectorTagWorkbench', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.confirmAction.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('衣橱默认收起，展开选择预设后再次收起不会卸下已选服装', async () => {
    const pb = usePromptBuilderStore()
    pb.subject = { kind: 'popular', characterId: 'test-character', outfitId: 'default', blueprintId: null }
    const wrapper = mount(DirectorTagWorkbench, {
      global: { stubs: { StudioTooltip: tooltipStub, ArchiveIcon: iconStub } },
    })
    const wardrobe = wrapper.get('details.universal-wardrobe-section')
    const element = wardrobe.element as HTMLDetailsElement
    const summary = wardrobe.get('summary')
    expect(element.open).toBe(false)

    await summary.trigger('click')
    expect(element.open).toBe(true)
    const preset = wardrobe.get('.universal-outfit-btn')
    await preset.trigger('click')
    expect(pb.outfitOverride?.tokens).toEqual(UNIVERSAL_WARDROBE_PRESETS[0].tags)
    expect(preset.attributes('aria-pressed')).toBe('true')

    await summary.trigger('click')
    expect(element.open).toBe(false)
    expect(pb.outfitOverride?.tokens).toEqual(UNIVERSAL_WARDROBE_PRESETS[0].tags)
    await summary.trigger('click')
    expect(preset.attributes('aria-pressed')).toBe('true')
    await preset.trigger('click')
    expect(pb.outfitOverride).toBeNull()
    wrapper.unmount()
  })

  it('点击清空词条必须先弹窗确认；取消后保留词条，确认后才真正清空', async () => {
    const pb = usePromptBuilderStore()
    pb.manualTags = new Set(['smile', 'white_dress'])
    const flashSpy = vi.spyOn(pb, 'flash')

    const wrapper = mount(DirectorTagWorkbench, {
      global: {
        stubs: { StudioTooltip: tooltipStub, ArchiveIcon: iconStub },
      },
    })

    const clearBtn = wrapper.find('.clear-tags-btn')
    expect(clearBtn.exists()).toBe(true)

    // 用户在确认框中取消
    mocks.confirmAction.mockResolvedValueOnce(false)
    await clearBtn.trigger('click')
    expect(mocks.confirmAction).toHaveBeenCalledWith(expect.objectContaining({
      danger: true,
      confirmLabel: '清空词条',
    }))
    expect(pb.manualTags.size).toBe(2)
    expect(flashSpy).not.toHaveBeenCalled()

    // 用户在确认框中点击确认
    mocks.confirmAction.mockResolvedValueOnce(true)
    await clearBtn.trigger('click')
    expect(pb.manualTags.size).toBe(0)
    expect(flashSpy).toHaveBeenCalledWith('已清空词条')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.clear-tags-btn').exists()).toBe(false)
    wrapper.unmount()
  })
})

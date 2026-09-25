import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import DirectorTagWorkbench from './DirectorTagWorkbench.vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'

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

  it('没有激活词条时不渲染清空按钮', () => {
    const pb = usePromptBuilderStore()
    pb.manualTags = new Set()
    const wrapper = mount(DirectorTagWorkbench, {
      global: {
        stubs: { StudioTooltip: tooltipStub, ArchiveIcon: iconStub },
      },
    })
    expect(wrapper.find('.clear-tags-btn').exists()).toBe(false)
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
  })
})

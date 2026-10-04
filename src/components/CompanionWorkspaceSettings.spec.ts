import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import CompanionWorkspaceSettings from './CompanionWorkspaceSettings.vue'

const pickWorkspace = vi.hoisted(() => vi.fn())
vi.mock('@/platform/desktop/capabilities', () => ({ getDesktopCapabilities: () => ({ pickWorkspace }) }))
vi.mock('@/composables/useFluidDialog', () => ({ useFluidDialog: () => ({ open: vi.fn(), close: vi.fn() }) }))
afterEach(() => pickWorkspace.mockReset())

function mountSettings() {
  return mount(CompanionWorkspaceSettings, {
    props: { open: true, modelValue: 'D:\\AI', saving: false },
    global: { stubs: { Teleport: true } },
  })
}

it('keeps the draft on cancel, selects without saving, and saves only on request', async () => {
  pickWorkspace.mockResolvedValueOnce(null).mockResolvedValueOnce('E:\\AI files')
  const wrapper = mountSettings()
  try {
    await wrapper.get('.companion-workspace-actions button').trigger('click')
    await flushPromises()
    expect(pickWorkspace).toHaveBeenCalledWith('D:\\AI')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    await wrapper.get('.companion-workspace-actions button').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('update:modelValue')).toEqual([['E:\\AI files']])
    expect(wrapper.emitted('save')).toBeUndefined()
    await wrapper.setProps({ modelValue: 'E:\\AI files' })
    await wrapper.get('.btn-primary').trigger('click')
    expect(wrapper.emitted('save')).toHaveLength(1)
  } finally { wrapper.unmount() }
})

it('blocks repeated selection and ignores a selection returned after closing and reopening', async () => {
  let resolve!: (value: string) => void
  pickWorkspace.mockImplementationOnce(() => new Promise<string>(done => { resolve = done }))
  const wrapper = mountSettings()
  try {
    const select = wrapper.get('.companion-workspace-actions button')
    await select.trigger('click')
    await select.trigger('click')
    await wrapper.get('input').trigger('keydown', { key: 'Enter' })
    expect(pickWorkspace).toHaveBeenCalledOnce()
    expect(wrapper.emitted('save')).toBeUndefined()
    await wrapper.setProps({ open: false })
    await wrapper.setProps({ open: true, modelValue: 'F:\\new draft' })
    resolve('E:\\old selection')
    await flushPromises()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    pickWorkspace.mockRejectedValueOnce(new Error('picker unavailable'))
    await select.trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('picker unavailable')
    expect(wrapper.get('input').attributes('disabled')).toBeUndefined()
  } finally { wrapper.unmount() }
})

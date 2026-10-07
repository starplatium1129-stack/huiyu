import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import CompanionWorkspaceSettings from './CompanionWorkspaceSettings.vue'
import { useWorkspaceDirectorySettings } from '../composables/chat/useWorkspaceDirectorySettings'
import type { DesktopAiWorkspace } from '../types/desktop'

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

it('reloads directories saved elsewhere on reopen without overwriting an edited or newer draft', async () => {
  const directory = (root: string): DesktopAiWorkspace => ({ root, exists: true, activeRoot: 'D:\\AI', restartRequired: root !== 'D:\\AI' })
  const getWorkspace = vi.fn().mockResolvedValue(directory('D:\\AI'))
  const setWorkspace = vi.fn()
  let state!: ReturnType<typeof useWorkspaceDirectorySettings>
  const wrapper = mount({ setup() { state = useWorkspaceDirectorySettings({ getWorkspace, setWorkspace }, vi.fn()); return () => null } })
  try {
    await flushPromises()
    expect(state.workspaceInput.value).toBe('D:\\AI')
    // The control room has saved E while Companion has remained mounted.
    getWorkspace.mockResolvedValueOnce(directory('E:\\AI'))
    state.workspaceOpen.value = true; await flushPromises()
    expect(state.workspaceInput.value).toBe('E:\\AI')
    expect(state.workspaceRestartRequired.value).toBe(true)
    expect(state.workspaceTooltip.value).toContain('E:\\AI')
    state.workspaceOpen.value = false
    let finish!: (value: DesktopAiWorkspace) => void
    getWorkspace.mockImplementationOnce(() => new Promise<DesktopAiWorkspace>(resolve => { finish = resolve }))
    state.workspaceOpen.value = true
    expect(state.workspaceInput.value).toBe('')
    await state.saveWorkspace()
    expect(setWorkspace).not.toHaveBeenCalled()
    state.workspaceInput.value = 'F:\\manual draft'
    finish(directory('E:\\AI')); await flushPromises()
    expect(state.workspaceInput.value).toBe('F:\\manual draft')
    state.workspaceOpen.value = false
    getWorkspace.mockImplementationOnce(() => new Promise<DesktopAiWorkspace>(resolve => { finish = resolve }))
    state.workspaceOpen.value = true
    state.workspaceOpen.value = false
    getWorkspace.mockResolvedValueOnce(directory('G:\\latest'))
    state.workspaceOpen.value = true; await flushPromises()
    finish(directory('E:\\stale')); await flushPromises()
    expect(state.workspaceInput.value).toBe('G:\\latest')
    expect(state.workspaceTooltip.value).toContain('G:\\latest')
  } finally { wrapper.unmount() }
})

it('keeps composition Enter native and saves only after a normal Enter', async () => {
  const wrapper = mountSettings()
  try {
    const input = wrapper.get('input').element
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...composition })
      input.dispatchEvent(event)
      expect(wrapper.emitted('save')).toBeUndefined()
      expect(event.defaultPrevented).toBe(false)
    }
    await wrapper.get('input').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('save')).toHaveLength(1)
  } finally { wrapper.unmount() }
})

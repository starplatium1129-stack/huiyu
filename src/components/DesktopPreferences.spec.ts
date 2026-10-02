import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import DesktopPreferences from './DesktopPreferences.vue'
import StudioSelect from './ui/StudioSelect.vue'
import { flushProfileWrites } from '@/platform/web/profileStorage'
import { settingsRepository } from '@/storage/settingsRepository'
import { DESKTOP_START_PAGE_SETTING } from '@/storage/desktopPreferences'

vi.mock('@/platform/desktop/capabilities', () => ({ getDesktopCapabilities: () => ({ isDesktop: true }) }))
vi.mock('@/platform/web/profileStorage', () => ({ profileLocalStorage: window.localStorage, flushProfileWrites: vi.fn() }))

beforeEach(() => {
  localStorage.clear()
  vi.mocked(flushProfileWrites).mockReset().mockResolvedValue(undefined)
})

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const mountPreferences = () => mount(DesktopPreferences, { global: { stubs: { StudioSelect: true } } })

it('waits for write confirmation instead of declaring the optimistic value saved', async () => {
  const confirmation = deferred()
  vi.mocked(flushProfileWrites).mockReturnValueOnce(confirmation.promise)
  const wrapper = mountPreferences()
  try {
    const select = wrapper.getComponent(StudioSelect)
    select.vm.$emit('update:modelValue', '/gallery')
    await flushPromises()
    expect(settingsRepository.get(DESKTOP_START_PAGE_SETTING)).toBe('/gallery')
    expect(select.props('modelValue')).toBe('/gallery')
    expect(wrapper.get('[role="status"]').text()).toContain('正在保存')
    confirmation.resolve()
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('已保存')
  } finally { wrapper.unmount() }
})

it.each(['rejected', 'readback-mismatch'] as const)('preserves the choice on %s and retries it explicitly', async failure => {
  const confirmation = deferred()
  vi.mocked(flushProfileWrites).mockReturnValueOnce(confirmation.promise)
  const wrapper = mountPreferences()
  try {
    const select = wrapper.getComponent(StudioSelect)
    select.vm.$emit('update:modelValue', '/video-studio')
    if (failure === 'rejected') confirmation.reject(new Error('fixture write receipt unavailable'))
    else {
      settingsRepository.set(DESKTOP_START_PAGE_SETTING, '/')
      confirmation.resolve()
    }
    await flushPromises()
    expect(select.props('modelValue')).toBe('/video-studio')
    expect(wrapper.get('[role="status"]').text()).toContain('保存尚未确认')
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(flushProfileWrites).toHaveBeenCalledTimes(2)
    expect(settingsRepository.get(DESKTOP_START_PAGE_SETTING)).toBe('/video-studio')
    expect(wrapper.get('[role="status"]').text()).toContain('已保存')
    expect(wrapper.find('button').exists()).toBe(false)
  } finally { wrapper.unmount() }
})

it.each(['success', 'failure'] as const)('ignores an older %s receipt during a newer selection', async outcome => {
  const older = deferred(), newer = deferred()
  vi.mocked(flushProfileWrites).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
  const wrapper = mountPreferences()
  try {
    const select = wrapper.getComponent(StudioSelect)
    select.vm.$emit('update:modelValue', '/gallery')
    select.vm.$emit('update:modelValue', '/prompt-builder')
    if (outcome === 'success') older.resolve()
    else older.reject(new Error('fixture old failure'))
    await flushPromises()
    expect(select.props('modelValue')).toBe('/prompt-builder')
    expect(wrapper.get('[role="status"]').text()).toContain('正在保存')
    expect(wrapper.find('button').exists()).toBe(false)
    newer.resolve()
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('已保存')
  } finally { wrapper.unmount() }
})

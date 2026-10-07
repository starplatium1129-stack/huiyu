import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeEach, expect, it, vi } from 'vitest'
import RuntimeConnectionNotice from './RuntimeConnectionNotice.vue'

const state = vi.hoisted(() => ({ blocked: false, pending: false, error: '', recovery: false }))
vi.mock('@/platform/desktop/capabilities', () => ({ getDesktopCapabilities: () => ({}) }))
vi.mock('@/platform/desktop/runtime', () => ({
  getDesktopRuntime: () => ({ connection: 'ready' }),
  onDesktopRuntime: () => () => {}, refreshDesktopRuntime: vi.fn(async () => {}),
}))
vi.mock('@/platform/web/profileStorage', () => ({
  profileWriteStatus: () => state, hasProfileRecoveryData: () => state.recovery,
  flushProfileWrites: vi.fn(async () => {}), exportProfileRecovery: vi.fn(),
}))
beforeEach(() => Object.assign(state, { blocked: false, pending: false, error: 'write failed', recovery: false }))

it('clears a recovered save warning and rereads newer failures or recovery data at notification time', async () => {
  const wrapper = mount(RuntimeConnectionNotice)
  try {
    expect(wrapper.text()).toContain('资料保存尚未完成')
    state.error = ''
    window.dispatchEvent(new Event('huiyu:profile-sync-complete')); await nextTick()
    expect(wrapper.find('section').exists()).toBe(false)
    state.error = 'newer failure'
    window.dispatchEvent(new Event('huiyu:profile-write-error')); await nextTick()
    window.dispatchEvent(new Event('huiyu:profile-sync-complete')); await nextTick()
    expect(wrapper.text()).toContain('资料保存尚未完成')
    state.error = ''; state.pending = true
    window.dispatchEvent(new Event('huiyu:profile-sync-complete')); await nextTick()
    expect(wrapper.text()).toContain('资料保存尚未完成')
    state.pending = false; state.recovery = true
    window.dispatchEvent(new Event('huiyu:profile-sync-complete')); await nextTick()
    expect(wrapper.text()).toContain('导出未保存草稿')
  } finally { wrapper.unmount() }
})

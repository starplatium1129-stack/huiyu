import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import DesktopUpdateBanner from '@/components/DesktopUpdateBanner.vue'
import { useDesktopUpdater } from './useDesktopUpdater'

describe('useDesktopUpdater', () => {
  let scope: ReturnType<typeof effectScope> | undefined

  beforeEach(() => {
    scope = effectScope()
    delete (window as unknown as { __TAURI__?: unknown }).__TAURI__
  })

  afterEach(() => {
    scope?.stop()
    scope = undefined
    vi.restoreAllMocks()
    delete (window as unknown as { __TAURI__?: unknown }).__TAURI__
  })

  it('在非桌面端环境中静默降级且不抛出异常', async () => {
    const updater = scope!.run(() => useDesktopUpdater())!
    expect(updater.supported).toBe(false)
    await expect(updater.check(true)).resolves.toBeUndefined()
    await expect(updater.install()).resolves.toBeUndefined()
    expect(updater.availableVersion.value).toBe('')
    expect(updater.installing.value).toBe(false)
  })

  it('桌面环境下检查发现新版本时仅更新版本提示，必须显式调用 install 才会触发安装', async () => {
    const invokeMock = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === 'desktop_update_check') return Promise.resolve('v1.8.0')
      if (cmd === 'desktop_update_install') return Promise.resolve(true)
      return Promise.resolve(null)
    })
    const listenMock = vi.fn().mockResolvedValue(() => {})

    ;(window as unknown as { __TAURI__: unknown }).__TAURI__ = {
      core: { invoke: invokeMock },
      event: { listen: listenMock },
    }

    const updater = scope!.run(() => useDesktopUpdater())!
    expect(updater.supported).toBe(true)

    // 自动检查仅返回版本，不触发安装
    await updater.check(true)
    expect(invokeMock).toHaveBeenCalledWith('desktop_update_check')
    expect(invokeMock).not.toHaveBeenCalledWith('desktop_update_install')
    expect(updater.availableVersion.value).toBe('v1.8.0')
    expect(updater.installing.value).toBe(false)

    // 显式点击调用 install 才真正触发安装
    await updater.install()
    expect(invokeMock).toHaveBeenCalledWith('desktop_update_install')
    expect(updater.installing.value).toBe(true)
    expect(updater.statusText.value).toBe('准备安装…')
  })
  it('keeps only the latest check and preserves install ownership until disposal', async () => {
    const pending: Array<{ resolve(value: string | null): void; reject(error: Error): void }> = []
    const listeners = new Map<string, (event: { payload: string }) => void>()
    const off = vi.fn()
    const invoke = vi.fn(() => new Promise<string | null>((resolve, reject) => pending.push({ resolve, reject })))
    ;(window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke }, event: {
      listen: vi.fn(async (name: string, listener: (event: { payload: string }) => void) => { listeners.set(name, listener); return off }),
    } }
    const updater = scope!.run(() => useDesktopUpdater())!
    const old = updater.check(), latest = updater.check()
    pending[1].resolve('next'); await latest
    pending[0].resolve('old'); await old
    expect(updater.availableVersion.value).toBe('next')
    const none = updater.check(); pending[2].resolve(null); await none
    expect(updater.availableVersion.value).toBe('')
    listeners.get('desktop-update-found')!({ payload: 'install-version' })
    const checking = updater.check(), installing = updater.install()
    listeners.get('desktop-update-progress')!({ payload: 'downloading' })
    pending[3].resolve(null); await checking
    await updater.check()
    expect(invoke).toHaveBeenCalledTimes(5)
    expect(updater.availableVersion.value).toBe('install-version')
    expect(updater.statusText.value).toBe('downloading')
    scope!.stop()
    pending[4].reject(new Error('late install failure')); await installing
    expect(updater.errorText.value).toBe('')
    expect(off).toHaveBeenCalledTimes(2)
    await updater.check(); await updater.install()
    expect(invoke).toHaveBeenCalledTimes(5)
  })

  it('shows a rejected install beside the advertised version and clears stale progress', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'desktop_update_check') return 'next'
      throw new Error('download unavailable')
    })
    ;(window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke }, event: { listen: vi.fn(async () => () => {}) } }
    const banner = mount(DesktopUpdateBanner)
    await flushPromises()
    await banner.get('button').trigger('click'); await flushPromises()
    expect(banner.text()).toContain('next')
    expect(banner.text()).toContain('更新失败：download unavailable')
    expect(banner.text()).not.toContain('准备安装')
    expect(banner.get('button').attributes('disabled')).toBeUndefined()
    banner.unmount()
  })

  it('shows real download progress, cancels once and permits an explicit retry', async () => {
    let finishInstall: ((installed: boolean) => void) | undefined
    const listeners = new Map<string, (event: { payload: string }) => void>()
    const invoke = vi.fn((command: string) => {
      if (command === 'desktop_update_check') return Promise.resolve('1.9.0')
      if (command === 'desktop_update_cancel') return Promise.resolve(true)
      return new Promise<boolean>(resolve => { finishInstall = resolve })
    })
    ;(window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke }, event: {
      listen: vi.fn(async (name: string, listener: (event: { payload: string }) => void) => { listeners.set(name, listener); return () => {} }),
    } }
    const banner = mount(DesktopUpdateBanner)
    await flushPromises()
    await banner.get('button').trigger('click')
    listeners.get('desktop-update-progress')!({ payload: '已下载 100.0 / 608.6 MiB（16%），平均 2.00 MiB/s' })
    await flushPromises()
    expect(banner.text()).toContain('100.0 / 608.6 MiB')
    expect(banner.get('button').text()).toBe('取消更新')
    await banner.get('button').trigger('click'); await flushPromises()
    expect(banner.get('button').attributes('disabled')).toBeDefined()
    expect(invoke.mock.calls.filter(([command]) => command === 'desktop_update_cancel')).toHaveLength(1)
    finishInstall!(false); await flushPromises()
    expect(banner.text()).toContain('更新已取消')
    expect(banner.text()).toContain('重新下载完整安装包')
    expect(banner.get('button').attributes('disabled')).toBeUndefined()
    await banner.get('button').trigger('click'); await flushPromises()
    expect(invoke.mock.calls.filter(([command]) => command === 'desktop_update_install')).toHaveLength(2)
    finishInstall!(false); await flushPromises()
    banner.unmount()
  })

})

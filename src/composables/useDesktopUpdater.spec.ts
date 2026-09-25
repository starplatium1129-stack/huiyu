import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
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
})

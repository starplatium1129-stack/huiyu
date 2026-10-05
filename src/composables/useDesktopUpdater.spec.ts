import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import DesktopUpdateBanner from '@/components/DesktopUpdateBanner.vue'
import type { DesktopUpdateState } from '@/platform/desktop/updater'
import { useDesktopUpdater } from './useDesktopUpdater'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function nativeSession(overrides: Record<string, () => unknown> = {}) {
  let state: DesktopUpdateState = { revision: 0, phase: 'idle', version: '', statusText: '', errorText: '', canCancel: false }
  const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>()
  const removers: ReturnType<typeof vi.fn>[] = []
  function emit(name: string, payload: unknown) { listeners.get(name)?.forEach(listener => listener({ payload })) }
  function update(next: Partial<DesktopUpdateState>, broadcast = true) {
    state = { ...state, ...next, revision: state.revision + 1 }
    if (broadcast) emit('desktop-update-state', { ...state })
    return { ...state }
  }
  const invoke = vi.fn(async (command: string) => {
    if (overrides[command]) return await overrides[command]()
    if (command === 'desktop_update_state') return { ...state }
    if (command === 'desktop_update_check') return 'next'
    if (command === 'desktop_update_install') {
      update({ phase: 'checking', version: 'next', statusText: '正在检查更新…', errorText: '', canCancel: true })
      return true
    }
    if (command === 'desktop_update_cancel') {
      update({ phase: 'cancelling', statusText: '正在取消更新…', canCancel: false })
      return true
    }
    throw new Error('unexpected command: ' + command)
  })
  const listen = vi.fn(async (name: string, listener: (event: { payload: unknown }) => void): Promise<() => void> => {
    const set = listeners.get(name) ?? new Set()
    listeners.set(name, set)
    set.add(listener)
    const remove = vi.fn(() => set.delete(listener))
    removers.push(remove)
    return remove
  })
  ;(window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke }, event: { listen } }
  return { invoke, listen, listeners, removers, update, emit }
}

describe('useDesktopUpdater', () => {
  let scope: ReturnType<typeof effectScope>
  const extraScopes: ReturnType<typeof effectScope>[] = []
  beforeEach(() => {
    scope = effectScope()
    delete (window as unknown as { __TAURI__?: unknown }).__TAURI__
  })
  afterEach(() => {
    scope.stop()
    extraScopes.splice(0).forEach(extra => extra.stop())
    vi.restoreAllMocks()
    delete (window as unknown as { __TAURI__?: unknown }).__TAURI__
  })

  it('在非桌面端环境中静默降级且不抛出异常', async () => {
    const updater = scope.run(() => useDesktopUpdater())!
    expect(updater.supported).toBe(false)
    await expect(updater.check(true)).resolves.toBeUndefined()
    await expect(updater.install()).resolves.toBeUndefined()
    expect(updater.availableVersion.value).toBe('')
    expect(updater.installing.value).toBe(false)
  })

  it('只检查版本，不自动安装；后台离线检查仍静默', async () => {
    const bridge = nativeSession()
    const updater = scope.run(() => useDesktopUpdater())!
    await updater.check(true)
    expect(updater.supported).toBe(true)
    expect(bridge.invoke).toHaveBeenCalledWith('desktop_update_check')
    expect(bridge.invoke).not.toHaveBeenCalledWith('desktop_update_install')
    expect(updater.availableVersion.value).toBe('next')
    expect(updater.installing.value).toBe(false)
    await updater.install()
    expect(updater.installing.value).toBe(true)
    expect(updater.statusText.value).toBe('正在检查更新…')
    scope.stop()
    nativeSession({ desktop_update_check: () => { throw new Error('offline') } })
    const second = effectScope(); extraScopes.push(second)
    const offline = second.run(() => useDesktopUpdater())!
    await offline.check(true)
    expect(offline.errorText.value).toBe('')
    await offline.check()
    expect(offline.errorText.value).toBe('offline')
  })

  it('保留最新检查，活动会话不被迟到检查或卸载后的命令结果覆盖', async () => {
    const checks: ReturnType<typeof deferred<string | null>>[] = []
    const install = deferred<boolean>()
    const bridge = nativeSession({
      desktop_update_check: () => { const pending = deferred<string | null>(); checks.push(pending); return pending.promise },
      desktop_update_install: () => install.promise,
    })
    const updater = scope.run(() => useDesktopUpdater())!
    const old = updater.check(), latest = updater.check()
    await flushPromises()
    checks[1].resolve('next'); await latest
    checks[0].resolve('old'); await old
    expect(updater.availableVersion.value).toBe('next')
    const none = updater.check(); await flushPromises(); checks[2].resolve(null); await none
    expect(updater.availableVersion.value).toBe('')
    bridge.emit('desktop-update-found', 'install-version')
    const checking = updater.check(); await flushPromises()
    const installing = updater.install(); await flushPromises()
    bridge.update({ phase: 'downloading', version: 'install-version', statusText: 'downloading', canCancel: true })
    checks[3].resolve(null); await checking
    await updater.check()
    expect(checks).toHaveLength(4)
    expect(updater.availableVersion.value).toBe('install-version')
    expect(updater.statusText.value).toBe('downloading')
    scope.stop()
    install.reject(new Error('late install failure')); await installing
    expect(updater.errorText.value).toBe('')
    expect(bridge.removers.every(remove => remove.mock.calls.length === 1)).toBe(true)
    expect(bridge.listeners.get('desktop-update-state')!.size).toBe(0)
    const calls = bridge.invoke.mock.calls.length
    await updater.check(); await updater.install()
    expect(bridge.invoke).toHaveBeenCalledTimes(calls)
  })

  it('失败通过会话广播展示并保留显式重试入口', async () => {
    const bridge = nativeSession({ desktop_update_install: () => {
      bridge.update({ phase: 'failed', version: 'next', statusText: '', errorText: 'download unavailable', canCancel: false })
      throw new Error('download unavailable')
    } })
    const banner = mount(DesktopUpdateBanner)
    await flushPromises()
    await banner.get('button').trigger('click'); await flushPromises()
    expect(banner.text()).toContain('next')
    expect(banner.text()).toContain('更新失败：download unavailable')
    expect(banner.get('button').text()).toBe('重试下载并安装')
    expect(banner.get('button').attributes('disabled')).toBeUndefined()
    banner.unmount()
    const reopened = mount(DesktopUpdateBanner)
    await flushPromises()
    expect(reopened.text()).toContain('更新失败：download unavailable')
    reopened.unmount()
    // An attempt can finish during checking, before Rust learns its version.
    for (const phase of ['cancelled', 'failed'] as const) {
      bridge.update({ phase, version: '', statusText: phase === 'cancelled' ? '更新已取消' : '', errorText: phase === 'failed' ? 'check unavailable' : '' }, false)
      const withoutVersion = mount(DesktopUpdateBanner)
      await flushPromises()
      expect(withoutVersion.text()).toContain('next')
      expect(withoutVersion.text()).toContain(phase === 'cancelled' ? '更新已取消' : 'check unavailable')
      expect(withoutVersion.get('button').attributes('disabled')).toBeUndefined()
      withoutVersion.unmount()
    }
  })

  it('双订阅和迟到订阅接续进度，取消结束后才能重试，交接后不能取消', async () => {
    let finishInstall = deferred<boolean>()
    const finishCancel = deferred<boolean>()
    const bridge = nativeSession({ desktop_update_cancel: () => finishCancel.promise, desktop_update_install: () => {
      bridge.update({ phase: 'downloading', version: '1.9.0', statusText: '已下载 100.0 / 608.6 MiB（16%）', errorText: '', canCancel: true })
      return finishInstall.promise
    } })
    const owner = mount(DesktopUpdateBanner)
    await flushPromises()
    await owner.get('button').trigger('click'); await flushPromises()
    const follower = mount(DesktopUpdateBanner)
    await flushPromises()
    expect(follower.text()).toContain('100.0 / 608.6 MiB')
    expect(follower.get('button').text()).toBe('取消更新')
    expect(bridge.invoke.mock.calls.filter(([command]) => command === 'desktop_update_install')).toHaveLength(1)
    await follower.get('button').trigger('click'); await flushPromises()
    bridge.update({ phase: 'downloading', statusText: 'later download progress', canCancel: true })
    await flushPromises()
    expect(follower.get('button').attributes('disabled')).toBeDefined()
    await follower.get('button').trigger('click')
    expect(bridge.invoke.mock.calls.filter(([command]) => command === 'desktop_update_cancel')).toHaveLength(1)
    bridge.update({ phase: 'cancelling', statusText: '正在取消更新…', canCancel: false })
    finishCancel.resolve(true); await flushPromises()
    expect(owner.get('button').attributes('disabled')).toBeDefined()
    expect(follower.get('button').attributes('disabled')).toBeDefined()
    bridge.emit('desktop-update-state', { revision: 0, phase: 'downloading', version: '1.9.0', statusText: 'stale progress', errorText: '', canCancel: true })
    // A deliberately older state cannot reopen cancellation or erase its status.
    expect(owner.text()).not.toContain('stale progress')
    bridge.update({ phase: 'cancelled', statusText: '更新已取消；再次升级将尝试续传，缓存失效时重新下载', canCancel: false })
    finishInstall.resolve(false); await flushPromises()
    expect(owner.text()).toContain('再次升级将尝试续传')
    expect(follower.get('button').attributes('disabled')).toBeUndefined()
    finishInstall = deferred<boolean>()
    await follower.get('button').trigger('click'); await flushPromises()
    bridge.update({ phase: 'installing', statusText: '签名校验通过，正在启动安装器…', canCancel: false })
    await flushPromises()
    expect(owner.get('button').text()).toBe('正在安装…')
    expect(owner.get('button').attributes('disabled')).toBeDefined()
    await owner.get('button').trigger('click')
    expect(bridge.invoke.mock.calls.filter(([command]) => command === 'desktop_update_cancel')).toHaveLength(1)
    finishInstall.resolve(true); await flushPromises()
    owner.unmount(); follower.unmount()
  })

  it('监听就绪再取快照，迟到快照不覆盖新状态，提前卸载释放迟到监听', async () => {
    const snapshot = deferred<DesktopUpdateState>()
    const bridge = nativeSession({ desktop_update_state: () => snapshot.promise })
    const registration = deferred<() => void>()
    bridge.listen.mockImplementationOnce(() => registration.promise)
    const updater = scope.run(() => useDesktopUpdater())!
    // Found registration is independent; the state listener is registered next.
    await flushPromises()
    const old = bridge.update({ phase: 'checking', version: 'next', statusText: 'checking', canCancel: true }, false)
    bridge.update({ phase: 'downloading', statusText: 'new progress' })
    snapshot.resolve(old); await flushPromises()
    expect(updater.statusText.value).toBe('new progress')
    scope.stop()
    const lateRemove = vi.fn()
    registration.resolve(lateRemove); await flushPromises()
    expect(lateRemove).toHaveBeenCalledTimes(1)

    const secondRegistration = deferred<() => void>()
    const secondBridge = nativeSession()
    secondBridge.listen.mockImplementationOnce(async (name, listener) => {
      secondBridge.listeners.set(name, new Set([listener]))
      return () => {}
    }).mockImplementationOnce(() => secondRegistration.promise)
    const second = effectScope(); extraScopes.push(second)
    second.run(() => useDesktopUpdater())!
    await flushPromises()
    expect(secondBridge.invoke).not.toHaveBeenCalledWith('desktop_update_state')
    second.stop()
    const remove = vi.fn(); secondRegistration.resolve(remove); await flushPromises()
    expect(remove).toHaveBeenCalledTimes(1)
    expect(secondBridge.invoke).not.toHaveBeenCalledWith('desktop_update_state')
  })

  it('并发安装拒绝和取消拒绝重新读取当前会话，不覆盖活动更新', async () => {
    const command = deferred<boolean>()
    const bridge = nativeSession({ desktop_update_install: () => command.promise, desktop_update_cancel: () => false })
    const updater = scope.run(() => useDesktopUpdater())!
    await updater.check()
    const installing = updater.install(); await flushPromises()
    bridge.update({ phase: 'downloading', version: 'next', statusText: 'other window progress', canCancel: true }, false)
    command.reject(new Error('已有更新正在进行')); await installing
    expect(updater.installing.value).toBe(true)
    expect(updater.errorText.value).toBe('')
    expect(updater.statusText.value).toBe('other window progress')
    bridge.update({ phase: 'installing', statusText: 'installer owns update', canCancel: false }, false)
    await updater.cancel()
    expect(updater.canCancel.value).toBe(false)
    expect(updater.statusText.value).toBe('installer owns update')
    expect(updater.errorText.value).toBe('')
  })
})

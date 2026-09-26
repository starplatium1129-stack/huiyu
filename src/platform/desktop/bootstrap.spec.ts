import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeDesktopBootstrap, readDesktopBootstrap } from './bootstrap'

const origin = 'http://127.0.0.1:4312'
const ready = {
  protocolVersion: 1, windowRole: 'atelier', connection: 'ready',
  windowId: 'atelier', sourceProfileId: `profile-${'a'.repeat(64)}`, sourceOrigin: origin,
  bundledUiAvailable: false,
  runtime: { origin, protocolVersion: 1, ownership: 'managed', runtimeEpoch: 'epoch-1', workspace: null },
}

afterEach(() => vi.unstubAllGlobals())

describe('desktop bootstrap wire contract', () => {
  it('invokes only the no-argument host bootstrap and decodes the descriptor', async () => {
    const invoke = vi.fn().mockResolvedValue(ready)
    vi.stubGlobal('window', { location: { origin }, __TAURI__: { core: { invoke } } })
    expect(await readDesktopBootstrap()).toEqual(ready)
    expect(invoke).toHaveBeenCalledWith('desktop_bootstrap', undefined)
  })

  it('rejects incompatible versions, unregistered roles and a different runtime origin', () => {
    vi.stubGlobal('window', { location: { origin } })
    expect(() => decodeDesktopBootstrap({ ...ready, protocolVersion: 2 })).toThrow('协议不兼容')
    expect(() => decodeDesktopBootstrap({ ...ready, windowRole: 'preview' })).toThrow('未获授权')
    expect(() => decodeDesktopBootstrap({ ...ready, runtime: { ...ready.runtime, origin: 'http://127.0.0.1:3000' } })).toThrow('来源不匹配')
  })

  it('keeps unavailable runtimes descriptor-free', () => {
    const unavailable = { ...ready, connection: 'unavailable', runtime: null }
    vi.stubGlobal('window', { location: { origin } })
    expect(decodeDesktopBootstrap(unavailable)).toEqual(unavailable)
    expect(() => decodeDesktopBootstrap({ ...unavailable, runtime: ready.runtime })).toThrow('状态无效')
  })

  it('accepts a host-selected loopback runtime from the bundled origin', () => {
    vi.stubGlobal('window', { location: { origin: 'http://tauri.localhost' } })
    expect(decodeDesktopBootstrap({ ...ready, sourceOrigin: 'http://tauri.localhost' }).runtime?.origin).toBe(origin)
    expect(() => decodeDesktopBootstrap({ ...ready, sourceOrigin: 'http://tauri.localhost',
      runtime: { ...ready.runtime, origin: 'https://untrusted.example' } })).toThrow('来源无效')
  })
})

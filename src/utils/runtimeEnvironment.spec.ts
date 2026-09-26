import { afterEach, describe, expect, it, vi } from 'vitest'
import { isLocalStudioHost } from './runtimeEnvironment'

afterEach(() => vi.unstubAllGlobals())

describe('local studio origin', () => {
  it('accepts only exact loopback and desktop hostnames', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'tauri.localhost']) {
      expect(isLocalStudioHost(host)).toBe(true)
    }
    for (const host of ['', 'evil-tauri.example', 'tauri.localhost.evil.test', 'localhost.evil.test', '192.168.1.2']) {
      expect(isLocalStudioHost(host)).toBe(false)
    }
  })

  it('does not let a desktop bridge authorize a remote page', () => {
    vi.stubGlobal('window', {
      location: { hostname: 'shared.example', protocol: 'https:' },
      companionDesktop: { isDesktop: true },
      __TAURI__: {},
    })
    expect(isLocalStudioHost()).toBe(false)
    expect(isLocalStudioHost('evil-tauri.example')).toBe(false)
  })

  it('checks the current protocol and supports the desktop custom scheme', () => {
    for (const protocol of ['http:', 'https:', 'tauri:']) {
      vi.stubGlobal('window', { location: { hostname: 'localhost', protocol } })
      expect(isLocalStudioHost()).toBe(true)
    }
    vi.stubGlobal('window', { location: { hostname: 'localhost', protocol: 'file:' } })
    expect(isLocalStudioHost()).toBe(false)
  })

  it('fails closed outside a browser without throwing', () => {
    vi.stubGlobal('window', undefined)
    expect(isLocalStudioHost()).toBe(false)
  })

  it('accepts the exact Electron HTTPS origin, not a claimed bridge or another scheme', () => {
    for (const origin of ['https://huiyu.localhost', 'http://huiyu.localhost', 'https://huiyu.localhost:444', 'https://huiyu.localhost.evil.test']) {
      const url = new URL(origin)
      vi.stubGlobal('window', { location: url, __HUIYU_ELECTRON__: {} })
      expect(isLocalStudioHost()).toBe(origin === 'https://huiyu.localhost')
    }
    expect(isLocalStudioHost('huiyu.localhost')).toBe(false)
  })
})

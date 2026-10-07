import { expect, it, vi } from 'vitest'
import { configureApiTransport, type FetchImplementation } from '../../api/client'
import { setRuntimeOrigin } from '../runtimeUrl'
import { desktopRuntimeFetch, getDesktopRuntime, initializeDesktopRuntime, refreshDesktopRuntime } from './runtime'

it('disposes pending bootstrap work and restarts the same runtime without inheriting aborted requests', async () => {
  vi.useFakeTimers()
  const origin = 'http://127.0.0.1:4312'
  const descriptor = { protocolVersion: 1, windowRole: 'atelier', windowId: 'atelier', connection: 'ready',
    sourceProfileId: `profile-${'a'.repeat(64)}`, sourceOrigin: origin, bundledUiAvailable: false,
    runtime: { origin, protocolVersion: 1, ownership: 'managed', runtimeEpoch: 'same-epoch', workspace: null } }
  const invoke = vi.fn().mockResolvedValue(descriptor), remove = vi.fn()
  const listen = vi.fn().mockResolvedValue(remove)
  vi.stubGlobal('window', { location: new URL(origin), __TAURI__: { core: { invoke }, event: { listen } } })
  const fetch = vi.fn<FetchImplementation>(async (_url, init) => {
    init?.signal?.throwIfAborted()
    return new Response('{}')
  })
  vi.stubGlobal('fetch', fetch)
  let dispose: (() => void) | undefined
  try {
    dispose = await initializeDesktopRuntime()
    const firstDispose = dispose, queuedEvent = listen.mock.calls[0][1]
    let finish!: (value: typeof descriptor) => void
    invoke.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const pending = refreshDesktopRuntime()
    firstDispose()
    queuedEvent({ payload: null })
    expect(invoke).toHaveBeenCalledTimes(2)
    finish({ ...descriptor, runtime: { ...descriptor.runtime, runtimeEpoch: 'stale-epoch' } })
    await pending
    expect(getDesktopRuntime().bootstrap?.runtime?.runtimeEpoch).toBe('same-epoch')
    dispose = await initializeDesktopRuntime()
    firstDispose() // A second old-owner cleanup must not abort the new lifetime.
    await expect(desktopRuntimeFetch('/api/status')).resolves.toBeInstanceOf(Response)
    expect((fetch.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(false)
    dispose()
    await vi.advanceTimersByTimeAsync(10000)
    expect(invoke).toHaveBeenCalledTimes(3)
    expect(remove).toHaveBeenCalledTimes(2)
  } finally {
    dispose?.(); setRuntimeOrigin(null, false); configureApiTransport()
    vi.unstubAllGlobals(); vi.useRealTimers()
  }
})

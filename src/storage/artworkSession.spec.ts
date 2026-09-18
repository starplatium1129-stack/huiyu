import { afterEach, describe, expect, it, vi } from 'vitest'
import { ARTWORK_SESSION_LOCK, createArtworkSession, withArtworkStaging } from './artworkSession'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
// Deterministic lock scheduling model; browser regressions also exercise the
// production source with native Web Locks in two real pages.
function lockManager() {
  type Request = { name: string; options: LockOptions; callback: (lock: Lock | null) => unknown; resolve: (value: unknown) => void; reject: (error: unknown) => void }
  const held = new Set<Request>(), pending: Request[] = []
  function available(request: Request) {
    return ![...held].some(other => other.name === request.name && (request.options.mode !== 'shared' || other.options.mode !== 'shared'))
  }
  function run(request: Request) {
    held.add(request)
    Promise.resolve().then(() => request.callback({ name: request.name, mode: request.options.mode ?? 'exclusive' } as Lock))
      .then(value => { held.delete(request); request.resolve(value); pump() }, error => { held.delete(request); request.reject(error); pump() })
  }
  function pump() {
    for (let index = 0; index < pending.length;) {
      const request = pending[index]
      if (available(request) && !pending.slice(0, index).some(other => other.name === request.name)) {
        pending.splice(index, 1); run(request)
      } else index++
    }
  }
  const request = vi.fn((name: string, options: LockOptions, callback: (lock: Lock | null) => unknown) => new Promise((resolve, reject) => {
    const entry = { name, options, callback, resolve, reject }
    if (options.ifAvailable && (!available(entry) || pending.some(other => other.name === name))) {
      Promise.resolve().then(() => callback(null)).then(resolve, reject)
    } else { pending.push(entry); pump() }
  }))
  return { locks: { request } as unknown as LockManager, held, pending }
}
afterEach(() => vi.unstubAllGlobals())

describe('document cleanup exclusion', () => {
  it('allows shared clients but refuses deletion while a second client is open', async () => {
    const manager = lockManager(), first = createArtworkSession(manager.locks), second = createArtworkSession(manager.locks)
    await Promise.all([first.start(), second.start()])
    const work = vi.fn(async () => 1)
    await expect(first.exclusively(work)).rejects.toThrow('其他绘遇窗口')
    expect(work).not.toHaveBeenCalled()
    expect(manager.held.size).toBe(2)
    await second.stop()
    await expect(first.exclusively(work)).resolves.toBe(1)
    expect(manager.held.size).toBe(1)
    await first.stop()
    expect(manager.held.size).toBe(0)
  })
  it('holds back a newly opened document until destructive work has finished', async () => {
    const manager = lockManager(), first = createArtworkSession(manager.locks), second = createArtworkSession(manager.locks)
    await first.start()
    const entered = deferred(), release = deferred()
    const cleanup = first.exclusively(async () => { entered.resolve(); await release.promise })
    await entered.promise
    let joined = false
    const joining = second.start().then(() => { joined = true })
    await Promise.resolve(); await Promise.resolve()
    expect(joined).toBe(false)
    release.resolve()
    await Promise.all([cleanup, joining])
    expect(joined).toBe(true)
    await Promise.all([first.stop(), second.stop()])
  })
  it('also refuses cleanup during image staging in the same document', async () => {
    const manager = lockManager(), client = createArtworkSession(manager.locks)
    vi.stubGlobal('navigator', { locks: manager.locks })
    await client.start()
    const entered = deferred(), release = deferred()
    const staging = withArtworkStaging(async () => { entered.resolve(); await release.promise })
    await entered.promise
    const work = vi.fn(async () => 0)
    await expect(client.exclusively(work)).rejects.toThrow('未删除图片')
    expect(work).not.toHaveBeenCalled()
    release.resolve(); await staging
    await expect(client.exclusively(work)).resolves.toBe(0)
    await client.stop()
  })
  it('rejoins after a failed deletion and permits retry without leaking locks', async () => {
    const manager = lockManager(), client = createArtworkSession(manager.locks)
    await expect(client.exclusively(async () => { throw new Error('disk') })).rejects.toThrow('disk')
    expect([...manager.held].map(request => [request.name, request.options.mode])).toEqual([[ARTWORK_SESSION_LOCK, 'shared']])
    await expect(client.exclusively(async () => 4)).resolves.toBe(4)
    await client.stop()
    expect(manager.held.size).toBe(0)
    expect(manager.pending).toEqual([])
  })
  it('serializes two local cleanup callers instead of releasing each other’s lease', async () => {
    const manager = lockManager(), client = createArtworkSession(manager.locks)
    const order: number[] = []
    await Promise.all([client.exclusively(async () => { order.push(1) }), client.exclusively(async () => { order.push(2) })])
    expect(order).toEqual([1, 2])
    expect(manager.held.size).toBe(1)
    await client.stop()
  })
  it('never executes destructive work without lock support', async () => {
    const work = vi.fn(async () => 0)
    await expect(createArtworkSession(undefined).exclusively(work)).rejects.toThrow('跨窗口安全清理')
    expect(work).not.toHaveBeenCalled()
  })
})

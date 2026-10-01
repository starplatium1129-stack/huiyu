import { afterEach, beforeEach, expect, it, vi } from 'vitest'

type Work = (references: string[], signal?: AbortSignal) => Promise<unknown>
type Coordinator = (work: Work, signal?: AbortSignal) => Promise<unknown>
const mocks = vi.hoisted(() => ({
  state: { connection: 'ready', bootstrap: { sourceProfileId: 'profile', sourceOrigin: 'https://fixture.test', windowRole: 'atelier', runtime: { runtimeEpoch: 'epoch-1', workspace: null } } },
  listeners: new Set<() => void>(), coordinator: undefined as Coordinator | undefined,
  start: vi.fn(async () => {}), stop: vi.fn(async () => {}), installs: vi.fn(),
}))
vi.mock('./runtime', () => ({
  getDesktopRuntime: () => mocks.state,
  onDesktopRuntime: (listener: () => void) => { mocks.listeners.add(listener); listener(); return () => mocks.listeners.delete(listener) },
}))
vi.mock('../../storage/artworkSession', () => ({
  installArtworkCleanupCoordinator: (coordinator: Coordinator) => {
    mocks.coordinator = coordinator; mocks.installs()
    return () => { if (mocks.coordinator === coordinator) mocks.coordinator = undefined }
  },
  startArtworkSession: mocks.start, stopArtworkSession: mocks.stop,
}))
vi.mock('../web/profileStorage', () => ({
  flushProfileWrites: async () => {}, hasPendingProfileWrites: () => false,
  hasProfileRecoveryData: () => false, profileDraftStorage: { getItem: () => null },
}))
vi.mock('../web/migrationBarrier', () => ({ assertMigrationWritable: () => {} }))

class Channel extends EventTarget {
  static opened: Channel[] = []
  closed = false
  postMessage = vi.fn()
  constructor() { super(); Channel.opened.push(this) }
  close() { this.closed = true }
  receive(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data })) }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const settle = async () => { for (let i = 0; i < 80; i++) await Promise.resolve() }
function publish() { for (const listener of [...mocks.listeners]) listener() }
let stop: (() => void) | undefined
let release: (() => void) | undefined
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); mocks.listeners.clear(); mocks.coordinator = undefined
  mocks.start.mockReset().mockResolvedValue(); mocks.stop.mockReset().mockResolvedValue(); mocks.installs.mockClear()
  mocks.state.connection = 'ready'; mocks.state.bootstrap.windowRole = 'atelier'; mocks.state.bootstrap.runtime.runtimeEpoch = 'epoch-1'
  Channel.opened = []; document.body.innerHTML = '<div id="app"><button>edit</button></div>'
  const held = new Map<string, LockMode>()
  vi.stubGlobal('BroadcastChannel', Channel)
  vi.stubGlobal('navigator', { locks: {
    query: async () => ({ held: [...held].map(([name, mode]) => ({ name, mode })), pending: [] }),
    request: async (name: string, options: LockOptions | ((lock: unknown) => unknown), callback?: (lock: unknown) => unknown) => {
      const work = typeof options === 'function' ? options : callback!
      if (held.has(name)) return work(null)
      held.set(name, 'exclusive')
      try { return await work({ name, mode: 'exclusive' }) } finally { held.delete(name) }
    },
  } })
})
afterEach(async () => {
  stop?.(); release?.(); await settle(); stop = release = undefined
  vi.unstubAllGlobals(); vi.useRealTimers(); document.body.innerHTML = ''
})
async function install() {
  const { installDesktopArtworkCleanup } = await import('./artworkCleanup')
  stop = await installDesktopArtworkCleanup({ isBusy: () => false })
  return import('../maintenanceParticipants')
}

for (const interruption of ['timeout', 'abort'] as const) it(`thaws a stuck initiating window on ${interruption} and rejects its late flush`, async () => {
  const hooks = await install(), waiting = deferred(), work = vi.fn(async () => 1), controller = new AbortController()
  release = hooks.registerMaintenanceParticipant(() => waiting.promise)
  let completed = false
  const pending = mocks.coordinator!(work, controller.signal).catch(() => { completed = true })
  await settle(); expect(hooks.maintenanceFrozen()).toBe(true)
  if (interruption === 'abort') controller.abort()
  else await vi.advanceTimersByTimeAsync(5100)
  await settle()
  expect(completed).toBe(true)
  expect(hooks.maintenanceFrozen()).toBe(false)
  const click = vi.fn(); document.querySelector('button')!.addEventListener('click', click)
  document.querySelector('button')!.click(); expect(click).toHaveBeenCalledOnce()
  waiting.resolve(); await pending; await settle(); expect(work).not.toHaveBeenCalled()
})

it('installs after an unavailable first handshake and replaces an obsolete epoch', async () => {
  mocks.state.connection = 'unavailable'; await install(); expect(mocks.coordinator).toBeUndefined()
  mocks.state.connection = 'ready'; publish(); await settle(); expect(mocks.coordinator).toBeTypeOf('function')
  expect(await mocks.coordinator!(async () => 1)).toBe(1)
  const previous = mocks.coordinator!
  mocks.state.bootstrap.runtime.runtimeEpoch = 'epoch-2'; publish(); await settle()
  expect(await mocks.coordinator!(async () => 2)).toBe(2)
  expect(Channel.opened.filter(channel => !channel.closed)).toHaveLength(1)
  expect(mocks.installs).toHaveBeenCalledTimes(2)
  await expect(previous(async () => 3)).rejects.toThrow('桌面连接已变化')
  publish(); await settle(); expect(mocks.installs).toHaveBeenCalledTimes(2)
})

it('finishes an active deletion before replacing its coordinator or reopening input', async () => {
  const hooks = await install(), waiting = deferred()
  const old = Channel.opened[0]
  const pending = mocks.coordinator!(async () => { await waiting.promise; return 1 })
  await settle(); expect(hooks.maintenanceFrozen()).toBe(true)
  mocks.state.bootstrap.runtime.runtimeEpoch = 'epoch-2'; publish(); await settle()
  expect(hooks.maintenanceFrozen()).toBe(true); expect(mocks.installs).toHaveBeenCalledTimes(1)
  waiting.resolve(); await pending; await settle()
  expect(hooks.maintenanceFrozen()).toBe(false); expect(mocks.installs).toHaveBeenCalledTimes(2)
  expect(old.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'resume' }))
  expect(await mocks.coordinator!(async () => 2)).toBe(2)
})

it('keeps a paused sibling sealed until its document lease rejoins before reinstallation', async () => {
  mocks.state.bootstrap.windowRole = 'companion'
  const hooks = await install(), rejoined = deferred()
  const old = Channel.opened[0]
  old.receive({ type: 'pause', requestId: 'a'.repeat(36), scope: 'profile:https%3A%2F%2Ffixture.test:epoch-1', deadlineAt: Date.now() + 5000 })
  await settle(); expect(mocks.stop).toHaveBeenCalledOnce(); expect(hooks.maintenanceFrozen()).toBe(true)
  mocks.start.mockReturnValueOnce(rejoined.promise)
  mocks.state.bootstrap.runtime.runtimeEpoch = 'epoch-2'; publish(); await settle()
  expect(hooks.maintenanceFrozen()).toBe(true); expect(Channel.opened).toHaveLength(1)
  const click = vi.fn(); document.querySelector('button')!.addEventListener('click', click)
  document.querySelector('button')!.click(); expect(click).not.toHaveBeenCalled()
  rejoined.resolve(); await settle()
  expect(hooks.maintenanceFrozen()).toBe(false); expect(Channel.opened).toHaveLength(2); expect(old.closed).toBe(true)
})

it('cancels a stuck source preparation on reconnect and ignores its eventual completion', async () => {
  const hooks = await install(), waiting = deferred(), work = vi.fn(async () => 1)
  release = hooks.registerMaintenanceParticipant(() => waiting.promise)
  let completed = false
  const pending = mocks.coordinator!(work).catch(() => { completed = true })
  await settle(); mocks.state.bootstrap.runtime.runtimeEpoch = 'epoch-2'; publish(); await settle()
  expect(completed).toBe(true); expect(hooks.maintenanceFrozen()).toBe(false)
  expect(mocks.installs).toHaveBeenCalledTimes(2)
  waiting.resolve(); await pending; await settle(); expect(work).not.toHaveBeenCalled()
})

it('does not reinstall after final disposal while an old deletion is finishing', async () => {
  const hooks = await install(), waiting = deferred()
  const pending = mocks.coordinator!(async () => waiting.promise)
  await settle(); stop!(); publish(); await settle()
  expect(mocks.coordinator).toBeUndefined(); expect(hooks.maintenanceFrozen()).toBe(true)
  waiting.resolve(); await pending; await settle()
  expect(hooks.maintenanceFrozen()).toBe(false); expect(mocks.installs).toHaveBeenCalledOnce()
  expect(Channel.opened.every(channel => channel.closed)).toBe(true)
})

it('recovers from an unavailable interval in the same epoch and removes all listeners on stop', async () => {
  await install()
  mocks.state.connection = 'unavailable'; publish(); await settle()
  expect(mocks.coordinator).toBeUndefined(); expect(Channel.opened[0].closed).toBe(true)
  mocks.state.connection = 'ready'; publish(); await settle()
  expect(await mocks.coordinator!(async () => 1)).toBe(1); expect(mocks.installs).toHaveBeenCalledTimes(2)
  stop!(); await settle(); expect(mocks.listeners.size).toBe(0)
  mocks.state.bootstrap.runtime.runtimeEpoch = 'epoch-2'; publish(); await settle()
  expect(mocks.coordinator).toBeUndefined(); expect(mocks.installs).toHaveBeenCalledTimes(2)
  expect(Channel.opened.every(channel => channel.closed)).toBe(true)
})

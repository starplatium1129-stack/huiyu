import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MigrationAuthorityTarget } from './migrationAuthority'
const KEY = 'huiyu:migration:barrier'
const target: MigrationAuthorityTarget = { migrationId: '11111111-1111-4111-8111-111111111111', workspaceId: 'candidate', generation: 1, sourceProfileId: 'profile', sourceOrigin: 'https://source', domains: ['artwork'] }
const original = { set: Storage.prototype.setItem, remove: Storage.prototype.removeItem, clear: Storage.prototype.clear }
let held = ['main'], pending: string[] = []
let query = vi.fn()
let respond: ((channel: Channel, message: Record<string, unknown>) => void) | undefined
class Channel extends EventTarget { onmessage: ((event: MessageEvent) => void) | null = null; postMessage(message: Record<string, unknown>) { respond?.(this, message) } close() {} }
beforeEach(() => {
  vi.resetModules(); respond = undefined; held = ['main']; pending = []; query = vi.fn(async () => ({ held: held.map(id => ({ name: `huiyu:migration:window:${id}` })), pending: pending.map(id => ({ name: `huiyu:migration:window:${id}` })) }))
  vi.stubGlobal('BroadcastChannel', Channel)
  vi.stubGlobal('navigator', { locks: { query, request: async (name: string, options: unknown, action?: (lock: unknown) => unknown) => (typeof options === 'function' ? options : action!)({ name }) } })
  original.clear.call(localStorage)
})
afterEach(() => {
  Storage.prototype.setItem = original.set; Storage.prototype.removeItem = original.remove; Storage.prototype.clear = original.clear
  original.clear.call(localStorage); vi.unstubAllGlobals(); vi.useRealTimers()
})
it('persists uncertain activation, rejects ordinary restart, and thaws only after adapter acknowledgment', async () => {
  const barrier = await import('./migrationBarrier')
  let finish!: () => void
  const reconcile = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  barrier.initializeMigrationParticipant({ windowId: 'main', reconcileAuthority: reconcile })
  await expect(barrier.freezeMigrationSource(async () => { barrier.markMigrationActivation(target); throw new Error('lost acknowledgment') })).rejects.toThrow('lost acknowledgment')
  expect(barrier.migrationRecoveryPending()).toBe(true)
  expect(() => localStorage.setItem('aics_theme', 'dark')).toThrow()
  await expect(barrier.freezeMigrationSource(async () => {})).rejects.toThrow('先执行只读核对')
  const recovery = barrier.recoverMigrationAuthority()
  await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce())
  expect(localStorage.getItem(KEY)).not.toBeNull()
  finish(); await recovery
  expect(localStorage.getItem(KEY)).toBeNull()
  expect(() => localStorage.setItem('aics_theme', 'dark')).not.toThrow()
})
it('retains freeze when an unacknowledged new window joins or a marker is malformed', async () => {
  const barrier = await import('./migrationBarrier')
  barrier.initializeMigrationParticipant({ windowId: 'main', reconcileAuthority: async () => { pending.push('new') } })
  await expect(barrier.freezeMigrationSource(async () => { barrier.markMigrationActivation(target); throw new Error('unknown') })).rejects.toThrow()
  await expect(barrier.recoverMigrationAuthority()).rejects.toThrow('窗口或维护身份发生变化')
  expect(barrier.migrationRecoveryPending()).toBe(true)
  for (const malformed of ['{malformed', ' []', 'invalid', JSON.stringify({ version: 1, requestId: 'r', target: { ...target, generation: -1 } })]) {
    original.set.call(localStorage, KEY, malformed)
    await expect(barrier.recoverMigrationAuthority()).rejects.toThrow('联系维护人员')
    await expect(barrier.freezeMigrationSource(async () => {})).rejects.toThrow('先执行只读核对')
  }
})
it('times out an unresponsive peer without thawing and accepts a later explicit retry after it closes', async () => {
  vi.useFakeTimers()
  const barrier = await import('./migrationBarrier')
  barrier.initializeMigrationParticipant({ windowId: 'main', reconcileAuthority: async () => {} })
  original.set.call(localStorage, KEY, JSON.stringify({ version: 1, requestId: 'request', target }))
  held.push('closed')
  const rejected = expect(barrier.recoverMigrationAuthority()).rejects.toThrow('窗口未完成')
  await vi.advanceTimersByTimeAsync(6000); await rejected
  expect(barrier.migrationRecoveryPending()).toBe(true)
  held = ['main']; await barrier.recoverMigrationAuthority()
  expect(barrier.migrationRecoveryPending()).toBe(false)
})

it('waits for the matching peer acknowledgment before releasing shared source writes', async () => {
  const barrier = await import('./migrationBarrier')
  barrier.initializeMigrationParticipant({ windowId: 'main', reconcileAuthority: async () => {} })
  original.set.call(localStorage, KEY, JSON.stringify({ version: 1, requestId: 'request', target }))
  held.push('peer')
  let acknowledge!: () => void
  respond = (channel, message) => {
    if (message.type !== 'reconcile') return
    const ack = { type: 'reconciled', requestId: message.requestId, roundId: message.roundId, windowId: 'peer', ok: true }
    channel.dispatchEvent(new MessageEvent('message', { data: { ...ack, roundId: 'obsolete' } }))
    acknowledge = () => channel.dispatchEvent(new MessageEvent('message', { data: ack }))
  }
  const recovery = barrier.recoverMigrationAuthority()
  await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'))
  expect(barrier.migrationRecoveryPending()).toBe(true)
  acknowledge(); await recovery
  expect(barrier.migrationRecoveryPending()).toBe(false)
})

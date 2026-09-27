import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProfilePort } from '../web/profileStorage'

const bridge = vi.hoisted(() => ({ listeners: new Map<string, (value: unknown) => void>(), invoke: vi.fn(async () => {}), ids: new Map<number, string>() }))
vi.mock('./hostApi', () => ({
  invokeHost: bridge.invoke,
  onHostEvent: (name: string, callback: (value: unknown) => void) => { const id = bridge.ids.size + 1; bridge.listeners.set(name, callback); bridge.ids.set(id, name); return id },
  offHostEvent: (id: number) => { bridge.listeners.delete(bridge.ids.get(id)!); bridge.ids.delete(id) },
}))
const id = 'a'.repeat(32)
const event = (name: string, value: unknown) => bridge.listeners.get('aics:maintenance-' + name)?.(value)
const prepare = (requestId = id, deadlineAt = Date.now() + 20000) => event('prepare', { requestId, deadlineAt })
const result = (state: 'cancelled' | 'blocked', requestId = id) => event('result', { requestId, state })
const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve() }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
let stop: (() => void) | undefined
let release: (() => void) | undefined
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); bridge.invoke.mockClear(); bridge.listeners.clear(); bridge.ids.clear()
  document.body.innerHTML = '<div id="app"><button>编辑</button></div>'; localStorage.clear()
})
afterEach(() => { stop?.(); release?.(); stop = release = undefined; vi.useRealTimers(); document.body.innerHTML = '' })
async function install(isBusy = () => false) {
  const { installDesktopMaintenance } = await import('./maintenance')
  stop = installDesktopMaintenance({ isBusy })
}

it('freezes input immediately and ACKs only after the last debounced draft has a durable receipt', async () => {
  const profile = await import('../web/profileStorage')
  const snapshot = { records: [], revision: 0, resetRevision: 'r1' }, saved = deferred()
  const saveDraft = vi.fn(async (input: { key: string; value: string | null }) => { await saved.promise; return { key: input.key, value: input.value, revision: 1 } })
  const port: ProfilePort = {
    readSettings: async () => snapshot, readChat: async () => snapshot, readDrafts: async () => snapshot,
    saveDraft, saveSetting: async input => ({ key: input.key, value: input.value, revision: 1 }),
    saveChatRecord: async input => ({ key: input.key, value: input.value, revision: 1 }), resetChat: async () => snapshot,
  }
  await profile.activateProfileStorage(port, 'companion')
  const { createChatDraftPersistence } = await import('@/composables/chat/chatDraftPersistence')
  const draft = createChatDraftPersistence((character, value) => profile.profileLocalStorage.setItem('aics_chat_draft_v1:' + character, JSON.stringify(value)))
  release = () => draft.dispose()
  draft.schedule('nene', 'last keystroke')
  await install()
  const click = vi.fn(); document.querySelector('button')!.addEventListener('click', click)
  prepare(); document.querySelector('button')!.click(); expect(click).not.toHaveBeenCalled()
  await settle()
  expect(saveDraft).toHaveBeenCalledWith(expect.objectContaining({ key: 'aics_chat_draft_v1:nene', value: '"last keystroke"' }))
  expect(bridge.invoke).not.toHaveBeenCalled()
  saved.resolve(); await settle()
  expect(bridge.invoke).toHaveBeenCalledWith('desktop_maintenance_ack', { requestId: id, ok: true })
  expect(() => profile.profileLocalStorage.setItem('aics_theme', 'light')).toThrow('MAINTENANCE_SEALED')
  prepare(); await settle(); expect(saveDraft).toHaveBeenCalledOnce()
  result('cancelled', 'b'.repeat(32)); document.querySelector('button')!.click(); expect(click).not.toHaveBeenCalled()
  result('cancelled'); document.querySelector('button')!.click(); expect(click).toHaveBeenCalledOnce()
})

it('rejects an explicit unsubmitted editor and thaws only when the host cancels', async () => {
  const hooks = await import('../maintenanceParticipants')
  release = hooks.registerMaintenanceParticipant(() => { throw new Error('OPEN_API_SETTINGS') })
  await install(); prepare(); await settle()
  expect(bridge.invoke).toHaveBeenCalledWith('desktop_maintenance_ack', { requestId: id, ok: false, error: 'OPEN_API_SETTINGS' })
  expect(hooks.maintenanceFrozen()).toBe(true)
  result('cancelled'); expect(hooks.maintenanceFrozen()).toBe(false)
})

it('does not send a late positive ACK after a deadline or cancellation', async () => {
  const hooks = await import('../maintenanceParticipants'), waiting = deferred()
  release = hooks.registerMaintenanceParticipant(() => waiting.promise)
  await install(); prepare(); await settle(); await vi.advanceTimersByTimeAsync(20000)
  expect(bridge.invoke).toHaveBeenCalledWith('desktop_maintenance_ack', { requestId: id, ok: false, error: 'FLUSH_TIMEOUT' })
  result('cancelled'); waiting.resolve(); await settle()
  expect(bridge.invoke).toHaveBeenCalledTimes(1); expect(hooks.maintenanceFrozen()).toBe(false)
})

it('keeps a blocked shutdown frozen even if a stale cancellation arrives', async () => {
  const hooks = await import('../maintenanceParticipants')
  await install(); prepare(); await settle(); result('blocked'); result('cancelled')
  expect(hooks.maintenanceFrozen()).toBe(true)
  expect(document.querySelector('[data-desktop-maintenance]')?.textContent).toContain('编辑已暂停')
})

it('refuses an artwork operation throughout the gap between its upload requests', async () => {
  const hooks = await import('../maintenanceParticipants'), writing = deferred()
  const operation = hooks.trackMaintenanceWrite(() => writing.promise)
  await install(); prepare(); await settle()
  expect(bridge.invoke).toHaveBeenCalledWith('desktop_maintenance_ack', { requestId: id, ok: false, error: 'ARTWORK_BUSY' })
  result('cancelled'); writing.resolve(); await operation
  expect(hooks.maintenanceParticipants()).toHaveLength(0)
})

it('preserves ongoing composition instead of acknowledging an uncommitted input', async () => {
  await install(); window.dispatchEvent(new CompositionEvent('compositionstart')); prepare(); await settle()
  expect(bridge.invoke).toHaveBeenCalledWith('desktop_maintenance_ack', { requestId: id, ok: false, error: 'INPUT_COMPOSING' })
})

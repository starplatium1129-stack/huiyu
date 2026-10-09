import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { initializePlatform } from './initializePlatform'
import type { MigrationAuthorityTarget } from './web/migrationAuthority'
import type { DesktopConnectionState } from './desktop/runtime'
const mocks = vi.hoisted(() => ({ state: {} as DesktopConnectionState, order: [] as string[], listener: undefined as ((state: DesktopConnectionState) => void) | undefined,
  reconcile: undefined as ((target: MigrationAuthorityTarget) => Promise<void>) | undefined, frozen: false, active: false, hydrate: vi.fn(), refresh: vi.fn() }))
vi.mock('@/storage/artworkRepository', () => ({ configureArtworkRepository: vi.fn() }))
vi.mock('./web/artworkRepository', () => ({ createWebArtworkRepository: vi.fn() }))
vi.mock('./desktop/artworkRepository', () => ({ createDesktopArtworkRepository: vi.fn() }))
vi.mock('./web/profilePort', () => ({ createProfilePort: vi.fn() }))
vi.mock('@/api/workspace', () => ({ workspaceRequest: vi.fn() }))
vi.mock('./web/profileStorage', () => ({ activateProfileStorage: mocks.hydrate, flushProfileWrites: vi.fn(), hasPendingProfileWrites: () => false, hasProfileRecoveryData: () => false, profileRuntimeActive: () => mocks.active, refreshProfileStorage: mocks.refresh, setProfileConnectionBlocked: vi.fn() }))
vi.mock('./web/migrationBarrier', () => ({ initializeMigrationParticipant: (options: { reconcileAuthority?: (target: MigrationAuthorityTarget) => Promise<void> }) => { mocks.order.push('lease'); if (options.reconcileAuthority) mocks.reconcile = options.reconcileAuthority }, retireWebArtworkWrites: vi.fn() }))
vi.mock('./desktop/runtime', () => ({ getDesktopRuntime: () => mocks.state, initializeDesktopRuntime: async () => { mocks.order.push('initial'); return () => {} }, refreshDesktopRuntime: async () => { mocks.order.push('read'); mocks.state = { ...mocks.state }; mocks.listener?.(mocks.state) }, onDesktopRuntime: (listener: (state: DesktopConnectionState) => void) => { mocks.listener = listener; listener(mocks.state); return () => {} } }))
vi.mock('./desktop/hostApi', () => ({ hostApi: () => ({}) }))
vi.mock('./maintenanceParticipants', () => ({ artworkCleanupFrozen: () => false, maintenanceFrozen: () => mocks.frozen }))
vi.mock('./desktop/maintenance', () => ({ installDesktopMaintenance: () => () => {} }))
vi.mock('./desktop/artworkCleanup', () => ({ installDesktopArtworkCleanup: async () => () => {} }))
afterEach(() => { mocks.listener = undefined; mocks.reconcile = undefined; mocks.frozen = false; mocks.active = false; vi.restoreAllMocks(); vi.resetAllMocks() })
it('coalesces publications behind a slow profile refresh and drops queued work after disposal', async () => {
  mocks.state = { connection:'ready', bootstrap:{ windowId:'atelier', runtime:{ workspace:{ workspaceId:'workspace', generation:1, domains:['settings','chat','draft'] } } } } as unknown as DesktopConnectionState
  mocks.active = true
  const stop = await initializePlatform(() => false)
  mocks.refresh.mockClear()
  let release!: () => void
  mocks.refresh.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  mocks.listener!(mocks.state)
  await flushPromises()
  for (let i = 0; i < 5; i++) mocks.listener!(mocks.state)
  expect(mocks.refresh).toHaveBeenCalledTimes(1)
  release(); await flushPromises()
  expect(mocks.refresh).toHaveBeenCalledTimes(2)
  mocks.refresh.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  mocks.listener!(mocks.state)
  await flushPromises()
  mocks.listener!(mocks.state)
  stop(); release(); await flushPromises()
  expect(mocks.refresh).toHaveBeenCalledTimes(3)
})
it.each([false, true])('skips only the hydrated initial replay, with publication during hydration: %s', async publishDuringHydration => {
  mocks.state = { connection: 'ready', bootstrap: { windowId: 'atelier', runtime: { workspace: { workspaceId: 'workspace', generation: 1, domains: ['settings', 'chat', 'draft'] } } } } as unknown as DesktopConnectionState
  const events = vi.spyOn(window, 'dispatchEvent')
  let finish!: () => void
  mocks.hydrate.mockImplementation(async () => {
    await new Promise<void>(resolve => { finish = resolve })
    mocks.active = true
  })
  const starting = initializePlatform(() => false)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  expect(events.mock.calls.some(([event]) => event.type === 'huiyu:profile-sync-complete')).toBe(false)
  if (publishDuringHydration) mocks.state = { ...mocks.state }
  finish()
  const stop = await starting
  expect(mocks.hydrate).toHaveBeenCalledTimes(1)
  expect(events.mock.calls.some(([event]) => event.type === 'huiyu:profile-sync-complete')).toBe(true)
  expect(mocks.refresh).toHaveBeenCalledTimes(publishDuringHydration ? 1 : 0)
  // Every later publication must still pick up another window's profile edits.
  mocks.listener!(mocks.state)
  await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(publishDuringHydration ? 2 : 1))
  stop()
})
it('reads authority after lease registration and acknowledges only completed adapter hydration', async () => {
  mocks.order = []
  mocks.state = { connection: 'ready', bootstrap: { windowId: 'atelier', sourceProfileId: 'profile', sourceOrigin: 'source', runtime: { workspace: { workspaceId: 'workspace', generation: 1, domains: [] } } } } as unknown as DesktopConnectionState
  const stop = await initializePlatform(() => false)
  expect(mocks.order.slice(0, 3)).toEqual(['initial', 'lease', 'read'])
  const target: MigrationAuthorityTarget = { migrationId: 'migration', workspaceId: 'workspace', generation: 1, sourceProfileId: 'profile', sourceOrigin: 'source', domains: ['artwork', 'settings', 'chat', 'draft'] }
  Object.assign(mocks.state.bootstrap!.runtime!.workspace!, { generation: 2, activeMigrationId: 'migration', domains: target.domains })
  mocks.frozen = true
  await expect(mocks.reconcile!(target)).rejects.toThrow('维护')
  mocks.frozen = false
  let finish!: () => void
  mocks.hydrate.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  let acknowledged = false
  const pending = mocks.reconcile!(target).then(() => { acknowledged = true })
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  expect(acknowledged).toBe(false)
  finish(); await pending
  expect(acknowledged).toBe(true)
  mocks.hydrate.mockRejectedValue(new Error('hydrate failed'))
  await expect(mocks.reconcile!(target)).rejects.toThrow('hydrate failed')
  stop()
})

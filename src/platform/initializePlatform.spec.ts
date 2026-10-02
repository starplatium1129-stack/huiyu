import { afterEach, expect, it, vi } from 'vitest'
import { initializePlatform } from './initializePlatform'
import type { MigrationAuthorityTarget } from './web/migrationAuthority'
import type { DesktopConnectionState } from './desktop/runtime'
const mocks = vi.hoisted(() => ({ state: {} as DesktopConnectionState, order: [] as string[], listener: undefined as (() => void) | undefined,
  reconcile: undefined as ((target: MigrationAuthorityTarget) => Promise<void>) | undefined, frozen: false, hydrate: vi.fn() }))
vi.mock('@/storage/artworkRepository', () => ({ configureArtworkRepository: vi.fn() }))
vi.mock('./web/artworkRepository', () => ({ createWebArtworkRepository: vi.fn() }))
vi.mock('./desktop/artworkRepository', () => ({ createDesktopArtworkRepository: vi.fn() }))
vi.mock('./web/profilePort', () => ({ createProfilePort: vi.fn() }))
vi.mock('@/api/workspace', () => ({ workspaceRequest: vi.fn() }))
vi.mock('./web/profileStorage', () => ({ activateProfileStorage: mocks.hydrate, flushProfileWrites: vi.fn(), hasPendingProfileWrites: () => false, hasProfileRecoveryData: () => false, profileRuntimeActive: () => false, refreshProfileStorage: vi.fn(), setProfileConnectionBlocked: vi.fn() }))
vi.mock('./web/migrationBarrier', () => ({ initializeMigrationParticipant: (options: { reconcileAuthority?: (target: MigrationAuthorityTarget) => Promise<void> }) => { mocks.order.push('lease'); if (options.reconcileAuthority) mocks.reconcile = options.reconcileAuthority }, retireWebArtworkWrites: vi.fn() }))
vi.mock('./desktop/runtime', () => ({ getDesktopRuntime: () => mocks.state, initializeDesktopRuntime: async () => { mocks.order.push('initial'); return () => {} }, refreshDesktopRuntime: async () => { mocks.order.push('read'); mocks.listener?.() }, onDesktopRuntime: (listener: () => void) => { mocks.listener = listener; listener(); return () => {} } }))
vi.mock('./desktop/hostApi', () => ({ hostApi: () => ({}) }))
vi.mock('./maintenanceParticipants', () => ({ artworkCleanupFrozen: () => false, maintenanceFrozen: () => mocks.frozen }))
vi.mock('./desktop/maintenance', () => ({ installDesktopMaintenance: () => () => {} }))
vi.mock('./desktop/artworkCleanup', () => ({ installDesktopArtworkCleanup: async () => () => {} }))
afterEach(() => { mocks.listener = undefined; mocks.reconcile = undefined; mocks.frozen = false; vi.clearAllMocks() })
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

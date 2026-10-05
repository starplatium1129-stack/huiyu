import { effectScope } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useWorkspaceMigration } from './useWorkspaceMigration'
const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown>, tasks: { activeCount: { value: 0 } }, prepare: vi.fn(), refresh: vi.fn(), migrate: vi.fn(), activate: vi.fn(), mark: vi.fn(), reconcile: vi.fn() }))
vi.mock('../platform/web/migrationBarrier', () => ({ migrationRecoveryPending: () => false, watchMigrationRecovery: () => () => {}, markMigrationActivation: mocks.mark, reconcileMigrationAuthority: mocks.reconcile, recoverMigrationAuthority: vi.fn() }))
vi.mock('../platform/desktop/runtime', () => ({ getDesktopRuntime: () => mocks.state, onDesktopRuntime: () => () => {}, refreshDesktopRuntime: mocks.refresh }))
vi.mock('../platform/desktop/bootstrap', () => ({ prepareDesktopWorkspace: mocks.prepare, activateDesktopWorkspace: mocks.activate, enableDesktopBundledUi: vi.fn() }))
vi.mock('../platform/desktop/capabilities', () => ({ getDesktopCapabilities: () => null }))
vi.mock('../api/workspace', () => ({ workspaceRequest: vi.fn() }))
vi.mock('../platform/web/migrationCoordinator', () => ({ migrateProfileToCandidate: mocks.migrate }))
vi.mock('../platform/web/profileStorage', () => ({ flushProfileWrites: vi.fn() }))
vi.mock('./useTaskCenter', () => ({ useTaskCenter: () => mocks.tasks }))
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const directory = { name: 'backup' } as FileSystemDirectoryHandle
beforeEach(() => {
  vi.clearAllMocks()
  mocks.tasks.activeCount.value = 0
  mocks.state = { connection: 'ready', bootstrap: { connection: 'ready', windowRole: 'atelier', windowId: 'one', sourceProfileId: 'profile', sourceOrigin: 'https://source', runtime: { origin: 'https://runtime', runtimeEpoch: 'epoch', workspace: { workspaceId: 'candidate', runtimeEpoch: 'candidate-epoch', generation: 1, domains: [] } } } }
  mocks.prepare.mockImplementation(async () => mocks.state.bootstrap); mocks.refresh.mockResolvedValue(undefined)
})
afterEach(() => { vi.unstubAllGlobals() })
it.each(['cancel', 'dispose', 'runtime', 'task', 'target'] as const)('rejects a late directory result after %s and excludes reentry', async reason => {
  const picker = deferred<FileSystemDirectoryHandle>()
  const choose = vi.fn(() => picker.promise)
  vi.stubGlobal('showDirectoryPicker', choose)
  const scope = effectScope(), message = vi.fn()
  const migration = scope.run(() => useWorkspaceMigration(message))!
  const running = migration.migrate()
  expect(migration.busy.value).toBe(true)
  await migration.migrate(true)
  expect(choose).toHaveBeenCalledTimes(1)
  if (reason === 'cancel') migration.cancel()
  if (reason === 'dispose') scope.stop()
  if (reason === 'runtime') mocks.state = { ...mocks.state, connection: 'unavailable' }
  if (reason === 'task') mocks.tasks.activeCount.value = 1
  if (reason === 'target') {
    const bootstrap = mocks.state.bootstrap as { runtime: { workspace: { generation: number } } }
    bootstrap.runtime.workspace.generation++
  }
  picker.resolve(directory); await running
  expect(mocks.prepare).not.toHaveBeenCalled()
  expect(mocks.migrate).not.toHaveBeenCalled()
  expect(migration.busy.value).toBe(false)
  if (reason === 'dispose') expect(message).not.toHaveBeenCalled()
  scope.stop()
})
it('keeps an already-started native activation pending until its acknowledgment', async () => {
  vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue(directory))
  const native = deferred<void>(), begun = deferred<void>()
  mocks.activate.mockImplementation(() => { begun.resolve(); return native.promise })
  mocks.migrate.mockImplementation(async options => { await options.prepareCandidate({ mode: 'new' }); await options.activate({ migrationId: 'migration', domains: ['artwork'] }); return { backupName: 'backup' } })
  const scope = effectScope(), message = vi.fn()
  const migration = scope.run(() => useWorkspaceMigration(message))!
  const running = migration.migrate()
  await begun.promise
  expect(migration.canCancel.value).toBe(false)
  migration.cancel()
  expect(migration.busy.value).toBe(true)
  expect(message).not.toHaveBeenCalled()
  const hydration = deferred<void>()
  mocks.reconcile.mockReturnValue(hydration.promise)
  native.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(migration.busy.value).toBe(true)
  expect(message).not.toHaveBeenCalled()
  hydration.resolve(); await running
  expect(message).toHaveBeenCalledWith(expect.stringContaining('迁移已完成'))
  scope.stop()
})

it('refuses an old candidate handshake after preparation confirms a new target', async () => {
  vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue(directory))
  const prepared = structuredClone(mocks.state.bootstrap) as { runtime: { workspace: { workspaceId: string } } }
  prepared.runtime.workspace.workspaceId = 'new-candidate'
  mocks.prepare.mockResolvedValue(prepared)
  const imported = vi.fn()
  mocks.migrate.mockImplementation(async options => {
    await options.prepareCandidate({ mode: 'new' })
    imported()
    return { backupName: 'backup' }
  })
  const scope = effectScope(), message = vi.fn()
  const migration = scope.run(() => useWorkspaceMigration(message))!
  await migration.migrate()
  expect(mocks.refresh).toHaveBeenCalledWith(true)
  expect(imported).not.toHaveBeenCalled()
  expect(message).toHaveBeenCalledWith(expect.stringContaining('迁移目标未确认'))
  scope.stop()
})

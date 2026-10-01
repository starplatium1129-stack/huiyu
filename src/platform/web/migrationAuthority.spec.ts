import { expect, it, vi } from 'vitest'
import { assertMigrationAuthority, bindMigrationCandidate, type MigrationAuthorityTarget } from './migrationAuthority'
import type { DesktopConnectionState } from '../desktop/runtime'
const target: MigrationAuthorityTarget = { migrationId: 'migration', workspaceId: 'candidate', generation: 1, sourceProfileId: 'profile', sourceOrigin: 'https://source', domains: ['artwork', 'settings'] }
function state(): DesktopConnectionState {
  return { connection: 'ready', bootstrap: { windowId: 'atelier', sourceProfileId: 'profile', sourceOrigin: 'https://source', runtime: { origin: 'https://runtime', runtimeEpoch: 'epoch', workspace: { workspaceId: 'candidate', runtimeEpoch: 'epoch', generation: 1, domains: [] } } } } as DesktopConnectionState
}
it('binds each import request to its immutable candidate and rejects reconnect before or during a call', async () => {
  const current = state(), request = vi.fn().mockResolvedValue({ ok: true })
  const port = bindMigrationCandidate(() => current, request)
  await port.request({ kind: 'migration.begin' })
  current.bootstrap!.runtime!.workspace!.generation++
  await expect(port.request({ kind: 'migration.record' })).rejects.toThrow('迁移目标已变化')
  expect(request).toHaveBeenCalledTimes(1)
  current.bootstrap!.runtime!.workspace!.generation--
  request.mockImplementation(async () => { current.bootstrap!.runtime!.runtimeEpoch = 'restarted'; return {} })
  await expect(port.request({ kind: 'migration.verify' })).rejects.toThrow('迁移目标已变化')
})
it('accepts only positive durable activation identity, allowing runtime restart but not missing legacy identity', () => {
  const current = state(), workspace = current.bootstrap!.runtime!.workspace!
  workspace.generation = 2; workspace.domains = ['artwork', 'settings']
  expect(() => assertMigrationAuthority(current, target)).toThrow()
  workspace.activeMigrationId = 'other'
  expect(() => assertMigrationAuthority(current, target)).toThrow()
  workspace.activeMigrationId = target.migrationId
  current.bootstrap!.runtime!.runtimeEpoch = 'restarted'
  expect(() => assertMigrationAuthority(current, target)).not.toThrow()
  workspace.domains = ['artwork']
  expect(() => assertMigrationAuthority(current, target)).toThrow()
})

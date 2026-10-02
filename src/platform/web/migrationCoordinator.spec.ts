import { expect, it, vi } from 'vitest'
import { migrateProfileToCandidate } from './migrationCoordinator'
const mocks = vi.hoisted(() => ({ imported: vi.fn(), envelope: { blockers: [], source: {}, records: [], media: [], credentials: {} } }))
vi.mock('./migrationBackup', () => ({ createMigrationDirectoryBackup: async () => ({ backupName: 'backup' }), readMigrationDirectoryBackup: async () => ({ envelope: mocks.envelope }) }))
vi.mock('./migrationExport', () => ({ migrationFingerprint: async () => 'same', exportMigrationSource: async (options: { consume: (value: unknown) => Promise<void> }) => { await options.consume(mocks.envelope); return mocks.envelope } }))
vi.mock('./migrationImport', () => ({ importMigrationBackup: mocks.imported }))
it.each([false, true])('honors cancellation after verification before activation (resume: %s)', async resume => {
  const controller = new AbortController(), activate = vi.fn()
  mocks.imported.mockImplementation(async () => { controller.abort(); return { state: 'verified', blockers: [] } })
  await expect(migrateProfileToCandidate({ sourceProfileId: 'profile', expectedOrigin: 'https://source', backupDirectory: { name: 'backup' } as FileSystemDirectoryHandle, candidate: { request: vi.fn() }, signal: controller.signal, activate, resume })).rejects.toThrow()
  expect(activate).not.toHaveBeenCalled()
})

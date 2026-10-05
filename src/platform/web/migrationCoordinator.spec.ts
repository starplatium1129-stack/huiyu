import { beforeEach, expect, it, vi } from 'vitest'
import { migrateProfileToCandidate } from './migrationCoordinator'
import type { MigrationCandidateSelection } from '../../../types/migration'
const mocks = vi.hoisted(() => ({
  imported: vi.fn(), fingerprint: vi.fn(), exported: vi.fn(),
  envelope: { migrationId: 'saved-migration', fingerprint: 'same', target: { workspaceId: 'saved-target' }, blockers: [] as string[], source: {}, records: [], media: [], credentials: {} },
}))
vi.mock('./migrationBackup', () => ({ createMigrationDirectoryBackup: async () => ({ backupName: 'backup' }), readMigrationDirectoryBackup: async () => ({ envelope: mocks.envelope }) }))
vi.mock('./migrationExport', () => ({ migrationFingerprint: mocks.fingerprint, exportMigrationSource: mocks.exported }))
vi.mock('./migrationImport', () => ({ importMigrationBackup: mocks.imported }))
function options(resume = false) {
  return { sourceProfileId: 'profile', expectedOrigin: 'https://source', backupDirectory: { name: 'backup' } as FileSystemDirectoryHandle,
    prepareCandidate: vi.fn(async (_selection: MigrationCandidateSelection) => ({ workspaceId: 'new-target', request: vi.fn() })), resume }
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.fingerprint.mockResolvedValue('same')
  mocks.exported.mockImplementation(async options => { await options.consume(mocks.envelope); return mocks.envelope })
  mocks.imported.mockResolvedValue({ state: 'verified', blockers: [] })
})
it.each([false, true])('honors cancellation after verification before activation (resume: %s)', async resume => {
  const controller = new AbortController(), activate = vi.fn()
  mocks.imported.mockImplementation(async () => { controller.abort(); return { state: 'verified', blockers: [] } })
  await expect(migrateProfileToCandidate({ ...options(resume), signal: controller.signal, activate })).rejects.toThrow()
  expect(activate).not.toHaveBeenCalled()
})
it('allocates a new candidate and fingerprints its target in the export', async () => {
  const request = options()
  await migrateProfileToCandidate(request)
  expect(request.prepareCandidate).toHaveBeenCalledWith({ mode: 'new' })
  expect(mocks.exported.mock.calls[0]![0].target).toEqual({ workspaceId: 'new-target' })
})
it('binds resume to the exact saved target, migration and fingerprint', async () => {
  const request = options(true)
  await migrateProfileToCandidate(request)
  expect(request.prepareCandidate).toHaveBeenCalledWith({ mode: 'resume', workspaceId: 'saved-target', migrationId: 'saved-migration', expectedFingerprint: 'same' })
  expect(mocks.imported.mock.calls[0]![0]).toBe(mocks.envelope)
})
it('rejects changed sources before switching candidates or importing', async () => {
  const request = options(true)
  mocks.fingerprint.mockResolvedValueOnce('same').mockResolvedValueOnce('changed-source').mockResolvedValueOnce('saved-source')
  await expect(migrateProfileToCandidate(request)).rejects.toThrow('建立新候选')
  expect(request.prepareCandidate).not.toHaveBeenCalled()
  expect(mocks.imported).not.toHaveBeenCalled()
})
it('rejects a damaged saved envelope before even reading the current source', async () => {
  const request = options(true)
  mocks.fingerprint.mockResolvedValueOnce('wrong')
  await expect(migrateProfileToCandidate(request)).rejects.toThrow('指纹不一致')
  expect(mocks.exported).not.toHaveBeenCalled()
  expect(request.prepareCandidate).not.toHaveBeenCalled()
})

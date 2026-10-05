import type { MigrationCandidateSelection, MigrationEnvelope, MigrationStatus } from '../../../types/migration'
import { createMigrationDirectoryBackup, readMigrationDirectoryBackup } from './migrationBackup'
import { exportMigrationSource, migrationFingerprint } from './migrationExport'
import { importMigrationBackup, type MigrationCandidatePort } from './migrationImport'
/** Run from the original origin/profile. The selected directory receives and
 * verifies a complete independent backup before a candidate sees any records.
 * Activation, if requested by the host, remains inside the maintenance barrier. */
export async function migrateProfileToCandidate(options: {
  sourceProfileId: string
  expectedOrigin: string
  backupDirectory: FileSystemDirectoryHandle
  prepareCandidate: (selection: MigrationCandidateSelection) => Promise<MigrationCandidatePort & { workspaceId: string }>
  signal?: AbortSignal
  migrateCredential?: (reference: string, secret: string) => Promise<boolean>
  activate?: (verified: MigrationStatus) => Promise<void>
  onProgress?: (phase: 'export' | 'import' | 'verify', completed: number, total: number) => void
  resume?: boolean
}): Promise<{ envelope: MigrationEnvelope; status: MigrationStatus; backupName: string }> {
  if (options.resume) return resumeProfileMigration(options)
  options.signal?.throwIfAborted()
  const candidate = await options.prepareCandidate({ mode: 'new' })
  options.signal?.throwIfAborted()
  const sink = await createMigrationDirectoryBackup(options.backupDirectory)
  let status: MigrationStatus | undefined
  const envelope = await exportMigrationSource({ sourceProfileId: options.sourceProfileId, expectedOrigin: options.expectedOrigin,
    signal: options.signal, sink, target: { workspaceId: candidate.workspaceId }, migrateCredential: options.migrateCredential,
    consume: async envelope => {
      if (envelope.blockers.length) throw new Error('来源包含未分类资料或未迁移凭据，已保留独立备份，尚未激活。')
      status = await importMigrationBackup(envelope, sink, candidate, options)
      if (status.state !== 'verified' || status.blockers.length) throw new Error('迁移校验发现缺失或冲突，来源与备份已保留，尚未激活。')
      options.signal?.throwIfAborted()
      await options.activate?.(status)
    },
  })
  return { envelope, status: status!, backupName: sink.backupName }
}

async function resumeProfileMigration(options: Parameters<typeof migrateProfileToCandidate>[0]) {
  const reader = await readMigrationDirectoryBackup(options.backupDirectory)
  const { fingerprint, ...unsigned } = reader.envelope
  if (await migrationFingerprint(unsigned) !== fingerprint || reader.envelope.blockers.length) throw new Error('迁移备份指纹不一致或有未解决的来源问题。')
  const sourceSnapshot = ({ source, records, media, credentials }: MigrationEnvelope) => ({ source, records, media, credentials })
  let status: MigrationStatus | undefined
  await exportMigrationSource({ sourceProfileId: options.sourceProfileId, expectedOrigin: options.expectedOrigin,
    signal: options.signal, migrateCredential: options.migrateCredential,
    // Existing independently saved files remain the backup; this pass verifies
    // the live source has not changed before reusing the saved checkpoint.
    sink: { record: async () => {}, media: async () => {}, manifest: async () => {}, verify: async () => {} },
    consume: async current => {
      if (current.blockers.length || await migrationFingerprint(sourceSnapshot(current)) !== await migrationFingerprint(sourceSnapshot(reader.envelope))) {
        throw new Error('来源已变化，不能把旧检查点套用到新资料；已保留旧备份与候选，请重新选择“迁移至本机工作区”建立新候选。')
      }
      options.signal?.throwIfAborted()
      const candidate = await options.prepareCandidate({ mode: 'resume', workspaceId: reader.envelope.target?.workspaceId,
        migrationId: reader.envelope.migrationId, expectedFingerprint: reader.envelope.fingerprint })
      status = await importMigrationBackup(reader.envelope, reader, candidate, options)
      if (status.state !== 'verified' || status.blockers.length) throw new Error('迁移副本尚未通过完整性校验。')
      options.signal?.throwIfAborted()
      await options.activate?.(status)
    },
  })
  return { envelope: reader.envelope, status: status!, backupName: options.backupDirectory.name }
}

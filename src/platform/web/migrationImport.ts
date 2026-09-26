import type { MigrationEnvelope, MigrationRecord, MigrationStatus } from '../../../types/migration'
import { migrationFingerprint } from './migrationExport'

export interface MigrationCandidatePort { request<T>(command: Record<string, unknown>, signal?: AbortSignal): Promise<T> }
export interface MigrationBackupReader {
  readRecord(id: string): Promise<MigrationRecord>
  readMedia(alias: string, offset: number): Promise<Uint8Array>
}
/** Resume the same saved envelope, never a newly-created snapshot under an old
 * checkpoint. This prepares a candidate only; activation still needs the host's
 * current-source maintenance and identity checks. */
export async function importMigrationBackup(envelope: MigrationEnvelope, reader: MigrationBackupReader, candidate: MigrationCandidatePort,
  options: { signal?: AbortSignal; onProgress?: (phase: 'import' | 'verify', completed: number, total: number) => void } = {}): Promise<MigrationStatus> {
  const { fingerprint, ...unsigned } = envelope
  if (await migrationFingerprint(unsigned) !== fingerprint || envelope.blockers.length) throw new Error('迁移备份指纹不一致或有未解决的来源问题。')
  const migrationId = envelope.migrationId
  const request = <T>(command: Record<string, unknown>) => candidate.request<T>(command, options.signal)
  const started = await request<MigrationStatus>({ kind: 'migration.begin', operationId: `${migrationId}:begin`, envelope })
  if (started.state === 'verified' || started.state === 'activated') return started
  const total = envelope.records.length + envelope.media.length
  let completed = 0
  for (const record of envelope.records) {
    const value = await reader.readRecord(record.id)
    const bytes = new TextEncoder().encode(JSON.stringify(value))
    if (bytes.length > 512 * 1024) {
      for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
        await request({ kind: 'migration.recordChunk', operationId: `${migrationId}:record:${record.id}:${offset}`, migrationId,
          itemId: record.id, offset, data: bytes.subarray(offset, offset + 1024 * 1024) })
      }
    } else await request({ kind: 'migration.record', operationId: `${migrationId}:record:${record.id}`, migrationId, itemId: record.id, record: value })
    options.onProgress?.('import', ++completed, total)
  }
  for (const media of envelope.media) {
    for (let offset = 0; offset < media.bytes; offset += 1024 * 1024) {
      const data = await reader.readMedia(media.alias, offset)
      await request({ kind: 'migration.media', operationId: `${migrationId}:media:${media.sha256}:${offset}`, migrationId, alias: media.alias, offset, data })
    }
    options.onProgress?.('import', ++completed, total)
  }
  options.onProgress?.('verify', completed, total)
  return request<MigrationStatus>({ kind: 'migration.verify', operationId: `${migrationId}:verify`, migrationId })
}

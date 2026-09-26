import type { MigrationEnvelope, MigrationRecord } from '../../../types/migration'
import { migrationFingerprint, type MigrationSink } from './migrationExport'

/** A user-selected backup directory is independent of both IndexedDB and the
 * destination candidate. Files are closed before read-back verification. */
export interface MigrationDirectoryBackup extends MigrationSink {
  backupName: string
  readRecord(id: string): Promise<MigrationRecord>
  readMedia(alias: string, offset: number): Promise<Uint8Array>
}
export async function createMigrationDirectoryBackup(directory: FileSystemDirectoryHandle): Promise<MigrationDirectoryBackup> {
  const backup = await directory.getDirectoryHandle(`huiyu-migration-${crypto.randomUUID()}`, { create: true })
  const records = await backup.getDirectoryHandle('records', { create: true })
  const media = await backup.getDirectoryHandle('media', { create: true })
  const write = async (target: FileSystemDirectoryHandle, name: string, data: string | Uint8Array, offset?: number) => {
    const file = await target.getFileHandle(name, { create: true })
    const stream = await file.createWritable({ keepExistingData: offset !== undefined })
    try {
      if (offset !== undefined) await stream.seek(offset)
      await stream.write(typeof data === 'string' ? data : new Uint8Array(data))
      await stream.close()
    } catch (error) { await stream.abort().catch(() => {}); throw error }
  }
  async function verify(envelope: MigrationEnvelope) {
    const saved = JSON.parse(await (await (await backup.getFileHandle('manifest.json')).getFile()).text()) as MigrationEnvelope
    if (JSON.stringify(saved) !== JSON.stringify(envelope)) throw new Error('迁移备份清单读回不一致。')
    for (const record of envelope.records) {
      const value: unknown = JSON.parse(await (await (await records.getFileHandle(`${record.id}.json`)).getFile()).text())
      if (await migrationFingerprint(value) !== record.sha256) throw new Error('迁移备份记录读回校验失败。')
    }
    for (const entry of envelope.media) {
      const file = await (await media.getFileHandle(await migrationFingerprint(entry.alias))).getFile()
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))).map(value => value.toString(16).padStart(2, '0')).join('')
      if (file.size !== entry.bytes || hash !== entry.sha256) throw new Error('迁移备份原图读回校验失败。')
    }
  }
  return {
    backupName: backup.name,
    readRecord: async id => JSON.parse(await (await (await records.getFileHandle(`${id}.json`)).getFile()).text()) as MigrationRecord,
    readMedia: async (alias, offset) => new Uint8Array(await (await (await media.getFileHandle(await migrationFingerprint(alias))).getFile()).slice(offset, offset + 1024 * 1024).arrayBuffer()),
    record: (id, record) => write(records, `${id}.json`, JSON.stringify(record)),
    media: async (alias, offset, bytes) => write(media, await migrationFingerprint(alias), bytes, offset),
    manifest: envelope => write(backup, 'manifest.json', JSON.stringify(envelope)),
    verify,
  }
}

export async function readMigrationDirectoryBackup(directory: FileSystemDirectoryHandle) {
  const envelope = JSON.parse(await (await (await directory.getFileHandle('manifest.json')).getFile()).text()) as MigrationEnvelope
  const records = await directory.getDirectoryHandle('records'), media = await directory.getDirectoryHandle('media')
  return {
    envelope,
    async readRecord(id: string) {
      if (!envelope.records.some(record => record.id === id)) throw new Error('记录不在迁移清单中。')
      return JSON.parse(await (await (await records.getFileHandle(`${id}.json`)).getFile()).text()) as MigrationRecord
    },
    async readMedia(alias: string, offset: number) {
      if (!envelope.media.some(entry => entry.alias === alias)) throw new Error('媒体不在迁移清单中。')
      const file = await (await media.getFileHandle(await migrationFingerprint(alias))).getFile()
      return new Uint8Array(await file.slice(offset, offset + 1024 * 1024).arrayBuffer())
    },
  }
}

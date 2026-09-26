import { kvPage } from '../../composables/useKVStore'
import { imgGetRecord, imgPage } from '../../composables/useImageStore'
import { classifyMigrationKey, credentialFields, parseMigrationValue } from './migrationClassification'
import { freezeMigrationSource } from './migrationBarrier'
import type { MigrationEnvelope, MigrationIdentity, MigrationRecord, MigrationRecordManifest } from '../../../types/migration'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
  return value
}
async function sha(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))).map(byte => byte.toString(16).padStart(2, '0')).join('')
}
export const migrationFingerprint = (value: unknown): Promise<string> => sha(new TextEncoder().encode(JSON.stringify(canonical(value))))
export interface MigrationSink {
  /** Durable independent backup, before any candidate import. */
  record(id: string, value: MigrationRecord): Promise<void>
  media(alias: string, offset: number, bytes: Uint8Array): Promise<void>
  manifest(envelope: MigrationEnvelope): Promise<void>
  verify(envelope: MigrationEnvelope): Promise<void>
}

/** The callback runs while all known windows are frozen. No image library-sized
 * Base64 allocation: each original is read independently and emitted in 1 MiB chunks. */
export async function exportMigrationSource(options: {
  sourceProfileId: string; expectedOrigin: string; sink: MigrationSink; signal?: AbortSignal
  migrateCredential?: (reference: string, secret: string) => Promise<boolean>
  consume?: (envelope: MigrationEnvelope) => Promise<void>
}): Promise<MigrationEnvelope> {
  if (!options.sourceProfileId || location.origin !== options.expectedOrigin) throw new Error('来源 profile 或 origin 不匹配，不能迁移。')
  return freezeMigrationSource(async snapshot => {
    const source: MigrationIdentity = { sourceProfileId: options.sourceProfileId, origin: location.origin, windowIds: snapshot.windowIds }
    const records: MigrationRecordManifest[] = [], media: MigrationEnvelope['media'] = [], blockers: string[] = []
    const references: string[] = []
    async function append(record: MigrationRecord) {
      options.signal?.throwIfAborted()
      const id = await migrationFingerprint([record.source, record.windowId || '', record.key, record.index ?? null])
      const secretPaths = credentialFields(record.value)
      if (record.domain === 'credential' || secretPaths.length) {
        // Secrets never enter backup bytes, manifests or logs. The old source is
        // retained and activation is blocked until the existing vault flow clears it.
        blockers.push(`credential:${id}`)
        return
      }
      if (record.domain === 'unknown') blockers.push(`unknown:${id}`)
      if (record.domain === 'transient') return
      const { value: _value, ...fields } = record
      records.push({ ...fields, id, sha256: await migrationFingerprint(record), bytes: new TextEncoder().encode(JSON.stringify(record)).length })
      await options.sink.record(id, record)
    }
    let cursor: string | undefined
    do {
      const page = await kvPage(cursor)
      for (const entry of page.entries) {
        const domain = classifyMigrationKey('kv', entry.key)
        // Collections are records, including an explicit empty marker. Unknown
        // fields remain in each raw value instead of passing a lossy UI codec.
        if (Array.isArray(entry.value) && entry.value.length) {
          for (let index = 0; index < entry.value.length; index++) await append({ source: 'kv', key: entry.key, index, domain, value: entry.value[index] })
        } else await append({ source: 'kv', key: entry.key, domain, value: entry.value })
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)!
      const raw = localStorage.getItem(key)!
      const parsed = parseMigrationValue(raw)
      const fields = credentialFields(parsed)
      if (fields.length) {
        // Only the established chat credential shapes are recognized; an unknown
        // secret field must never be serialized to a general-purpose package.
        const body = parsed as Record<string, unknown>
        const known = key === 'aics_chat_v1' ? ['settings.apiKey', 'apiKey', 'api.apiKey'] : []
        const draft = key === 'aics_chat_api_drafts'
        let valid = Boolean(options.migrateCredential)
        for (const field of fields) {
          const parts = field.split('.')
          const owner = parts.slice(0, -1).reduce<unknown>((current, part) => current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : null, body) as Record<string, unknown>
          if (!known.includes(field) && !(draft && parts.length === 2 && parts[1] === 'apiKey')) { valid = false; break }
          const settings = body.settings as Record<string, unknown> | undefined
          const endpoint = String(owner.apiBaseUrl || owner.baseUrl || settings?.apiBaseUrl || '')
          let reference = endpoint
          try { const url = new URL(endpoint); if (draft) { url.hash = `huiyu-api-draft-${parts[0]}`; reference = url.href } } catch { valid = false; break }
          if (!await options.migrateCredential?.(reference, String(owner[parts.at(-1)!]))) { valid = false; break }
          references.push(reference)
          owner[parts.at(-1)!] = ''
        }
        if (!valid) { blockers.push(`credential:${await migrationFingerprint(['local', key])}`); continue }
        await append({ source: 'local', key, domain: classifyMigrationKey('local', key), value: JSON.stringify(parsed) })
      } else await append({ source: 'local', key, domain: classifyMigrationKey('local', key), value: raw })
    }
    for (const [windowId, values] of Object.entries(snapshot.sessions)) {
      for (const [key, value] of Object.entries(values)) {
        if (credentialFields(parseMigrationValue(value)).length) { blockers.push(`credential:${await migrationFingerprint(['session', key])}`); continue }
        await append({ source: 'session', key, windowId, domain: classifyMigrationKey('session', key), value })
      }
    }
    cursor = undefined
    do {
      const page = await imgPage(cursor)
      for (const entry of page.entries) {
        options.signal?.throwIfAborted()
        if (!(entry.blob instanceof Blob) || entry.blob.size <= 0) { blockers.push(`media:${entry.id}`); continue }
        const bytes = new Uint8Array(await entry.blob.arrayBuffer())
        const { blob: _blob, ...metadata } = entry
        if (credentialFields(metadata).length) { blockers.push(`credential:${await migrationFingerprint(['media', entry.id])}`); continue }
        media.push({ alias: entry.id, sha256: await sha(bytes), bytes: bytes.length, mime: entry.type || entry.blob.type,
          metadata, derived: entry.id.startsWith('thumb:') })
        for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
          options.signal?.throwIfAborted()
          await options.sink.media(entry.id, offset, bytes.subarray(offset, offset + 1024 * 1024))
        }
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    // The reader can distinguish unavailable credentials from a verified empty vault.
    const credentials = { references, verified: !blockers.some(item => item.startsWith('credential:')) }
    const unsigned = { format: 'huiyu-migration' as const, version: 1 as const, migrationId: crypto.randomUUID(), source,
      createdAt: Date.now(), records, media, blockers, credentials }
    const envelope: MigrationEnvelope = { ...unsigned, fingerprint: await migrationFingerprint(unsigned) }
    await options.sink.manifest(envelope)
    await options.sink.verify(envelope)
    await options.consume?.(envelope)
    return envelope
  }, options.signal)
}

export async function* migrationMediaChunks(alias: string, signal?: AbortSignal): AsyncGenerator<{ offset: number; data: Uint8Array }> {
  const record = await imgGetRecord(alias)
  if (!record) throw new Error('迁移原图缺失，不能继续。')
  for (let offset = 0; offset < record.blob.size; offset += 1024 * 1024) {
    signal?.throwIfAborted()
    yield { offset, data: new Uint8Array(await record.blob.slice(offset, offset + 1024 * 1024).arrayBuffer()) }
  }
}

import type { ProfileRecord, ProfileSnapshot } from '../../../types/profile'
import type { ProfilePort } from './profileStorage'

interface State { epoch: number; writes: number; reset: string; pending: boolean; archiveLoaded: boolean; archiveVersion?: string }
export interface ChatActions {
  port: ProfilePort
  values: Map<string, ProfileRecord>
  revisions: Map<string, number>
  optimistic: WeakSet<ProfileRecord>
  state(): State
  flush(): Promise<void>
  ready(version?: string): void
  write(value: unknown): Promise<void>
  writable(): void
  isChat(key: string): boolean
  reset(snapshot: ProfileSnapshot): void
}
const identity = 'local:aics_chat_archive_v1'
export async function readArchive(access: ChatActions): Promise<unknown> {
  await access.flush()
  const before = access.state(), cached = access.values.get(identity)
  const known = cached && !access.optimistic.has(cached) ? cached.version : before.archiveLoaded ? before.archiveVersion : undefined
  const snapshot = await access.port.readChatArchive(known)
  const record = snapshot.unchanged ? cached : snapshot.records.find(record => record.key === 'aics_chat_archive_v1')
  const after = access.state()
  if (before.epoch !== after.epoch || before.writes !== after.writes || after.pending
    || (snapshot.unchanged && access.values.get(identity) !== cached)
    || before.archiveVersion !== after.archiveVersion && snapshot.version !== after.archiveVersion
    || snapshot.resetRevision !== after.reset || (record?.revision ?? 0) < (access.revisions.get(identity) ?? 0)) throw new Error('聊天资料已变化，请重新读取归档。')
  if (!snapshot.unchanged) {
    if (record) { access.values.set(identity,structuredClone(record)); access.revisions.set(identity,record.revision) }
    else { access.values.delete(identity); access.revisions.delete(identity) }
  }
  access.ready(snapshot.version)
  const value = record?.value ?? null
  return typeof value === 'string' ? JSON.parse(value) as unknown : snapshot.unchanged ? structuredClone(value) : value
}
export async function writeArchive(access: ChatActions, value: unknown): Promise<void> {
  if (!access.state().archiveLoaded) await readArchive(access)
  await access.flush()
  await access.write(value)
}
export async function resetChat(access: ChatActions): Promise<void> {
  access.writable()
  await access.flush()
  const before = access.state()
  const snapshot = await access.port.resetChat({ operationId: crypto.randomUUID(), expectedReset: before.reset })
  const after = access.state()
  if (before.epoch !== after.epoch || before.writes !== after.writes || after.pending) throw new Error('聊天清除已交接，资料在等待期间变化，请重新读取。')
  for (const [key, record] of access.values) if (access.isChat(record.key) || record.key.startsWith('aics_chat_draft_v1:')) {
    access.values.delete(key); access.revisions.delete(key)
  }
  access.reset(snapshot)
  for (const record of snapshot.records) access.revisions.set(`local:${record.key}`,record.revision)
}

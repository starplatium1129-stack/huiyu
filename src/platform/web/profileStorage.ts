import type { ProfileDomain, ProfileRecord, ProfileSnapshot } from '../../../types/profile'
import { classifyMigrationKey } from './migrationClassification.ts'
const profileDomainForKey = (key: string): ProfileDomain | null => {
  const domain = classifyMigrationKey('local', key)
  return domain === 'settings' || domain === 'chat' || domain === 'draft' ? domain : null
}
import { assertMigrationWritable } from './migrationBarrier.ts'

export interface ProfilePort {
  readSettings(): Promise<ProfileSnapshot>
  saveSetting(input: { operationId: string; key: string; value: string | null; expectedRevision: number | null }): Promise<ProfileRecord>
  readChat(): Promise<ProfileSnapshot>
  saveChatRecord(input: { operationId: string; key: string; value: unknown; expectedRevision: number | null; expectedReset: string }): Promise<ProfileRecord>
  resetChat(input: { operationId: string; expectedReset: string }): Promise<ProfileSnapshot>
  readDrafts(windowId: string): Promise<ProfileSnapshot>
  saveDraft(input: { operationId: string; key: string; value: string | null; windowId?: string; expectedRevision: number | null; expectedReset: string }): Promise<ProfileRecord>
}
let port: ProfilePort | null = null
let windowId = ''
let generation = 0
let resetRevision = ''
const values = new Map<string, ProfileRecord>()
let pending = Promise.resolve()
let failure: unknown = null
const outbox: Array<() => Promise<void>> = []
let draining = false
let connectionBlocked = false
const recovery = new Map<string, { key: string; value: unknown; reason: string }>()
const cacheKey = (key: string, session: boolean) => `${session ? 'session' : 'local'}:${key}`

function take(snapshot: ProfileSnapshot, session = false) {
  for (const record of snapshot.records) values.set(cacheKey(record.key, session), structuredClone(record))
  resetRevision = snapshot.resetRevision
}
/** Bootstrap awaits hydration before mounting; once selected, runtime failures
 * never select the old browser records as an alternate writable authority. */
export async function installProfilePort(next: ProfilePort, id: string): Promise<void> {
  if (outbox.length) throw new Error('仍有未确认的资料保存，请先完成保存。')
  const current = ++generation
  const [settings, chat, drafts] = await Promise.all([next.readSettings(), next.readChat(), next.readDrafts(id)])
  if (current !== generation) throw new Error('Profile bootstrap was superseded')
  values.clear(); take(settings); take(chat)
  for (const record of drafts.records) values.set(cacheKey(record.key, !record.key.startsWith('aics_chat_draft_v1:') && !record.key.startsWith('aics-model-draft-') && record.key !== 'aics_pb_last_draft'), structuredClone(record))
  resetRevision = chat.resetRevision
  port = next; windowId = id; failure = null
}
export function profileRuntimeActive(): boolean { return port !== null }
export function setProfileConnectionBlocked(blocked: boolean): void { connectionBlocked = blocked }
export function hasPendingProfileWrites(): boolean { return outbox.length > 0 || draining }
export function profileWriteStatus(): { blocked: boolean; pending: boolean; error: string } {
  return { blocked: connectionBlocked, pending: hasPendingProfileWrites(), error: failure instanceof Error ? failure.message : failure ? '本机资料尚未保存。' : recovery.size ? '另一窗口已清空聊天；本页未保存内容已保留，可导出草稿。' : '' }
}
export function hasProfileRecoveryData(): boolean { return recovery.size > 0 }
export function exportProfileRecovery(): Blob { return new Blob([JSON.stringify({ format: 'huiyu-unsaved-profile', version: 1, records: [...recovery.values()] }, null, 2)], { type: 'application/json' }) }
function assertProfileWritable() {
  if (connectionBlocked) throw new Error('本机资料连接尚未确认，已暂停保存；请保持窗口打开并等待重连。')
  assertMigrationWritable()
}
export async function flushProfileWrites(): Promise<void> {
  if (connectionBlocked && outbox.length) throw new Error('本机资料连接尚未确认，待保存资料已保留。')
  if (!draining && outbox.length) { failure = null; drain() }
  await pending
  if (failure) throw failure
}
function publishError(error: unknown) {
  failure = error
  window.dispatchEvent(new CustomEvent('huiyu:profile-write-error', { detail: '本机资料尚未保存，请保持窗口打开并重新连接。' }))
}
function queueWrite(domain: ProfileDomain, key: string, value: unknown, session: boolean): void {
  // Confirmed runtime authority can retain offline edits in memory. Unknown
  // startup authority still cannot write to the old browser source.
  assertMigrationWritable()
  const identity = cacheKey(key, session), selected = port!, epoch = generation
  let operationId = crypto.randomUUID()
  const previous = values.get(identity)
  const optimistic = { key, value, revision: previous?.revision ?? 0 }
  values.set(identity, optimistic)
  let expectedRevision: number | null | undefined
  const expectedReset = resetRevision
  let baseValue = structuredClone(previous?.value ?? null), sendValue: unknown = JSON.parse(JSON.stringify(value))
  outbox.push(async () => {
    if (epoch !== generation) throw new Error('Profile authority changed')
    if (expectedRevision === undefined) expectedRevision = revisions.get(identity) ?? null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const input = { operationId, key, value: sendValue as string | null, expectedRevision }
        const saved = domain === 'settings' ? await selected.saveSetting(input)
          : domain === 'chat' ? await selected.saveChatRecord({ ...input, expectedReset })
            : await selected.saveDraft({ ...input, ...(session ? { windowId } : {}), expectedReset })
        revisions.set(identity, saved.revision)
        if (values.get(identity) === optimistic) values.set(identity, structuredClone(saved))
        return
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : ''
        if (code !== 'REVISION_CONFLICT' && code !== 'PROFILE_RESET_CONFLICT') throw error
        const latest = domain === 'settings' ? await selected.readSettings() : domain === 'chat' ? await selected.readChat() : await selected.readDrafts(windowId)
        const remote = latest.records.find(record => record.key === key)
        if (domain !== 'settings' && latest.resetRevision !== expectedReset) {
          recovery.set(identity, { key, value, reason: 'chat-reset' })
          const chat = domain === 'chat' ? latest : await selected.readChat()
          for (const [entryId, record] of values) if (profileDomainForKey(record.key) === 'chat' || record.key.startsWith('aics_chat_draft_v1:')) {
            values.delete(entryId); revisions.delete(entryId)
          }
          take(chat)
          for (const record of chat.records) revisions.set(cacheKey(record.key, false), record.revision)
          window.dispatchEvent(new StorageEvent('storage', { key: 'aics_chat_v1' }))
          window.dispatchEvent(new CustomEvent('huiyu:profile-write-error', { detail: '另一窗口已清空聊天，旧内容未重新写入；可导出本页未保存草稿。' }))
          return
        }
        const { mergeProfileChatConflict, mergeProfileSettingConflict } = await import('./profileConflict.ts')
        if (domain === 'chat') sendValue = await mergeProfileChatConflict(key, baseValue, sendValue, remote?.value ?? null)
        else if (domain === 'settings') sendValue = mergeProfileSettingConflict(baseValue, sendValue, remote?.value ?? null)
        baseValue = structuredClone(remote?.value ?? null)
        expectedRevision = remote?.revision ?? null
        // A 409 proved this operation did not commit. Only this branch may use a
        // new identity/input; network-unknown retries keep their original pair.
        operationId = crypto.randomUUID()
      }
    }
    throw new Error('其他窗口正在修改同一资料，请稍后重试；当前编辑已保留。')
  })
  drain()
}
function drain() {
  if (draining || failure || connectionBlocked) return
  draining = true
  pending = (async () => {
    try { while (outbox.length) { assertProfileWritable(); await outbox[0](); outbox.shift() } }
    catch (error) { publishError(error) }
    finally { draining = false }
  })()
}
const revisions = new Map<string, number>()
export async function activateProfileStorage(next: ProfilePort, id: string): Promise<void> {
  await installProfilePort(next, id)
  connectionBlocked = false
  revisions.clear()
  for (const [key, record] of values) revisions.set(key, record.revision)
}
export async function refreshProfileStorage(): Promise<void> {
  if (!port) return
  await flushProfileWrites()
  const current = generation
  const [settings, chat, drafts] = await Promise.all([port.readSettings(), port.readChat(), port.readDrafts(windowId)])
  if (current !== generation || outbox.length) return
  const before = new Map([...values].map(([identity, record]) => [identity, JSON.stringify(record.value)]))
  values.clear(); revisions.clear(); take(settings); take(chat)
  for (const record of drafts.records) {
    const session = !record.key.startsWith('aics_chat_draft_v1:') && !record.key.startsWith('aics-model-draft-') && record.key !== 'aics_pb_last_draft'
    values.set(cacheKey(record.key, session), record)
  }
  for (const [identity, record] of values) {
    revisions.set(identity, record.revision)
    if (before.get(identity) !== JSON.stringify(record.value)) window.dispatchEvent(new StorageEvent('storage', { key: record.key }))
  }
}
function createStorage(session: boolean): Storage {
  const native = () => session ? globalThis.sessionStorage : globalThis.localStorage
  const currentKeys = () => [...new Set([...Array.from({ length: native().length }, (_, index) => native().key(index)!),
    ...[...values.keys()].filter(key => key.startsWith(session ? 'session:' : 'local:')).map(key => key.slice(session ? 8 : 6))])]
  return {
    get length() { return port ? currentKeys().length : native().length },
    key(index) { return port ? currentKeys()[index] ?? null : native().key(index) },
    getItem(key) {
      if (!port || !profileDomainForKey(key)) return native().getItem(key)
      const value = values.get(cacheKey(key, session))?.value
      return value === undefined || value === null ? null : typeof value === 'string' ? value : JSON.stringify(value)
    },
    setItem(key, value) {
      const domain = profileDomainForKey(key)
      if (!port || !domain) { assertProfileWritable(); native().setItem(key, value); return }
      queueWrite(domain, key, String(value), session)
    },
    removeItem(key) {
      const domain = profileDomainForKey(key)
      if (!port || !domain) { assertProfileWritable(); native().removeItem(key); return }
      queueWrite(domain, key, null, session)
    },
    clear() { assertProfileWritable(); if (port) throw new Error('请使用对应资料领域的清除功能。'); native().clear() },
  }
}
export const profileLocalStorage = createStorage(false)
export const profileDraftStorage = createStorage(true)

export async function readProfileChatArchive(): Promise<unknown> {
  if (!port) throw new Error('Profile runtime is not active')
  await flushProfileWrites()
  take(await port.readChat())
  const record = values.get(cacheKey('aics_chat_archive_v1', false))
  if (record) revisions.set(cacheKey(record.key, false), record.revision)
  return typeof record?.value === 'string' ? JSON.parse(record.value) as unknown : record?.value ?? null
}
export async function writeProfileChatArchive(value: unknown): Promise<void> {
  if (!port) throw new Error('Profile runtime is not active')
  await flushProfileWrites()
  queueWrite('chat', 'aics_chat_archive_v1', value, false)
  await flushProfileWrites()
}
export async function resetProfileChat(): Promise<void> {
  assertProfileWritable()
  if (!port) throw new Error('Profile runtime is not active')
  await flushProfileWrites()
  const snapshot = await port.resetChat({ operationId: crypto.randomUUID(), expectedReset: resetRevision })
  for (const [identity, record] of values) if (profileDomainForKey(record.key) === 'chat' || record.key.startsWith('aics_chat_draft_v1:')) {
    values.delete(identity); revisions.delete(identity)
  }
  take(snapshot)
  for (const record of snapshot.records) revisions.set(cacheKey(record.key, false), record.revision)
}

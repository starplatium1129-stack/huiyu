import type { ProfileDomain, ProfileRecord, ProfileSnapshot } from '../../../types/profile'
import { createProfileWriteReceipt, type ProfileWriteReceipt } from './profileWriteReceipt.ts'
export type { ProfileWriteReceipt } from './profileWriteReceipt.ts'
import { CHAT_DRAFT_PREFIX, CHAT_PREFERENCES_KEY, SD_PENDING_QUEUE_KEY } from '../../utils/storageKeys.ts'
import { assertChatJsonVersion } from '../../utils/chatVersion.ts'
import { classifyMigrationKey } from './migrationClassification.ts'
const profileDomainForKey = (key: string): ProfileDomain | null => {
  const domain = classifyMigrationKey('local', key)
  return domain === 'settings' || domain === 'chat' || domain === 'draft' ? domain : null
}
import { assertMigrationWritable } from './migrationBarrier.ts'
import { assertMaintenanceWritable } from '../maintenanceParticipants.ts'

export interface ProfilePort {
  readSettings(ifVersion?: string): Promise<ProfileSnapshot>
  saveSetting(input: { operationId: string; key: string; value: string | null; expectedRevision: number | null }): Promise<ProfileRecord>
  readChat(ifVersion?: string, ifArchiveVersion?: string): Promise<ProfileSnapshot>
  readChatArchive(ifVersion?: string): Promise<ProfileSnapshot>
  saveChatRecord(input: { operationId: string; key: string; value: unknown; baseValue?: unknown; expectedRevision: number | null; expectedReset: string }): Promise<ProfileRecord>
  resetChat(input: { operationId: string; expectedReset: string }): Promise<ProfileSnapshot>
  readDrafts(windowId: string, ifVersion?: string): Promise<ProfileSnapshot>
  saveDraft(input: { operationId: string; key: string; value: string | null; windowId?: string; expectedRevision: number | null; expectedReset: string }): Promise<ProfileRecord>
}
let port: ProfilePort | null = null
let windowId = ''
let generation = 0
let writeVersion = 0
let refreshVersion = 0
let resetRevision = ''
// Replace this object on every invalidation, even if the token was already
// absent: a partial archive read must supersede an in-flight full refresh.
let snapshotVersions: Partial<Record<ProfileDomain, string>> = {}
const values = new Map<string, ProfileRecord>()
const optimisticRecords = new WeakSet<ProfileRecord>()
const checkedChatVersions = new WeakMap<ProfileRecord, number>()
let pending = Promise.resolve()
let failure: unknown = null
const outbox: Array<{ run: () => Promise<'confirmed' | 'recovered'>; delivery: ReturnType<typeof createProfileWriteReceipt> }> = []
const latestWrites = new Map<string, ProfileWriteReceipt>()
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
async function installProfilePort(next: ProfilePort, id: string): Promise<void> {
  if (outbox.length) throw new Error('仍有未确认的资料保存，请先完成保存。')
  const current = ++generation
  const [settings, chat, drafts] = await Promise.all([next.readSettings(), next.readChat(), next.readDrafts(id)])
  if (current !== generation) throw new Error('Profile bootstrap was superseded')
  if (settings.resetRevision !== chat.resetRevision || drafts.resetRevision !== chat.resetRevision) throw new Error('聊天资料在同步期间被清空，请重新读取。')
  values.clear(); take(settings); take(chat)
  for (const record of drafts.records) values.set(cacheKey(record.key, !record.key.startsWith('aics_chat_draft_v1:') && !record.key.startsWith('aics-model-draft-') && record.key !== 'aics_pb_last_draft'), structuredClone(record))
  resetRevision = chat.resetRevision
  snapshotVersions = { settings: settings.version, chat: chat.version, draft: drafts.version }
  port = next; windowId = id; failure = null; latestWrites.clear()
}
export function profileRuntimeActive(): boolean { return port !== null }
/** Confirmed chat records are private clones. Cache only a successful check,
 * never serialized archives or checks of caller-owned optimistic values. */
export function assertProfileChatVersion(key: string, current: number): boolean {
  if (!port || profileDomainForKey(key) !== 'chat') return false
  const record = values.get(cacheKey(key, false))
  if (!record || checkedChatVersions.get(record) === current) return true
  const value = record.value
  assertChatJsonVersion(value === undefined || value === null ? null : typeof value === 'string' ? value : JSON.stringify(value), current)
  if (!optimisticRecords.has(record)) checkedChatVersions.set(record, current)
  return true
}
export function setProfileConnectionBlocked(blocked: boolean): void { connectionBlocked = blocked }
export function hasPendingProfileWrites(): boolean { return outbox.length > 0 || draining }
export function profileWriteStatus(): { blocked: boolean; pending: boolean; error: string } {
  return { blocked: connectionBlocked, pending: hasPendingProfileWrites(), error: failure instanceof Error ? failure.message : failure ? '本机资料尚未保存。' : recovery.size ? '另一窗口已清空聊天；本页未保存内容已保留，可导出草稿。' : '' }
}
export function hasProfileRecoveryData(): boolean { return recovery.size > 0 }
export function exportProfileRecovery(): Blob { return new Blob([JSON.stringify({ format: 'huiyu-unsaved-profile', version: 1, records: [...recovery.values()] }, null, 2)], { type: 'application/json' }) }
function assertProfileWritable() {
  assertMaintenanceWritable()
  if (connectionBlocked) throw new Error('本机资料连接尚未确认，已暂停保存；请保持窗口打开并等待重连。')
  assertMigrationWritable()
}
export async function flushProfileWrites(): Promise<void> {
  if (connectionBlocked && outbox.length) throw new Error('本机资料连接尚未确认，待保存资料已保留。')
  resumeWrites()
  await pending
  if (failure) throw failure
}
function resumeWrites() {
  if (failure && draining) { for (const entry of outbox) entry.delivery.block(failure); return }
  if (connectionBlocked) {
    const error = new Error('本机资料连接尚未确认，待保存资料已保留。')
    for (const entry of outbox) entry.delivery.block(error)
    return
  }
  if (!draining && outbox.length) { failure = null; outbox[0].delivery.queued(); drain() }
}
function publishError(error: unknown) {
  failure = error
  window.dispatchEvent(new CustomEvent('huiyu:profile-write-error', { detail: '本机资料尚未保存，请保持窗口打开并重新连接。' }))
}
function queueWrite(domain: ProfileDomain, key: string, value: unknown, session: boolean): ProfileWriteReceipt {
  assertMaintenanceWritable()
  // Confirmed runtime authority can retain offline edits in memory. Unknown
  // startup authority still cannot write to the old browser source.
  assertMigrationWritable()
  const identity = cacheKey(key, session), selected = port!, epoch = generation
  let operationId = crypto.randomUUID()
  const previous = values.get(identity)
  const queuedPredecessor = previous && optimisticRecords.has(previous)
  const mergedSetting = domain === 'settings' && (key === 'aics_scene_favorites' || key === 'aics_hidden_scenes' || key === CHAT_PREFERENCES_KEY)
  const optimistic = { key, value, revision: previous?.revision ?? 0 }
  optimisticRecords.add(optimistic)
  writeVersion++
  snapshotVersions = { ...snapshotVersions, [domain]: undefined }
  values.set(identity, optimistic)
  let expectedRevision: number | null | undefined
  let expectedReset = resetRevision
  // Confirmed chat records are private snapshots; conflict merges only read
  // their baseline. Optimistic values can still be edited by their caller.
  let baseValue: unknown = domain === 'chat' && previous && !optimisticRecords.has(previous)
    ? previous.value ?? null : structuredClone(previous?.value ?? null)
  // Strings/null already have JSON value semantics and cannot share mutable state.
  let sendValue: unknown = typeof value === 'string' || value === null ? value : JSON.parse(JSON.stringify(value))
  const delivery = createProfileWriteReceipt(key, resumeWrites)
  latestWrites.set(identity, delivery.receipt)
  outbox.push({ delivery, run: async () => {
    if (epoch !== generation) throw new Error('Profile authority changed')
    if (expectedRevision === undefined) {
      // A queued predecessor may have merged another window's IDs. Carry only
      // this write's original delta forward, once, before its first submission.
      if (domain === 'chat' && queuedPredecessor && previous) {
        const { mergeProfileChatConflict } = await import('./profileConflict.ts')
        sendValue = await mergeProfileChatConflict(key, baseValue, sendValue, previous.value)
        baseValue = structuredClone(previous.value)
      } else if (mergedSetting && previous) {
        const { mergeProfileSettingConflict } = await import('./profileConflict.ts')
        sendValue = mergeProfileSettingConflict(key, baseValue, sendValue, previous.value)
        baseValue = structuredClone(previous.value)
      }
      expectedRevision = revisions.get(identity) ?? null
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const input = { operationId, key, value: sendValue as string | null, expectedRevision }
        const saved = domain === 'settings' ? await selected.saveSetting(input)
          : domain === 'chat' ? await selected.saveChatRecord({ ...input, baseValue, expectedReset })
            : await selected.saveDraft({ ...input, ...(session ? { windowId } : {}), expectedReset })
        revisions.set(identity, saved.revision)
        // Successors retain this exact node. Publish the merged body along with
        // its revision before the queue advances, so their original delta is
        // rebased onto the committed predecessor rather than an old snapshot.
        if (mergedSetting || domain === 'chat') Object.assign(optimistic, structuredClone(saved))
        if (values.get(identity) === optimistic) values.set(identity, structuredClone(saved))
        return 'confirmed'
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : ''
        if (code !== 'REVISION_CONFLICT' && code !== 'PROFILE_RESET_CONFLICT') throw error
        // Queue snapshots cannot be merged or rebased over another writer.
        if (key === SD_PENDING_QUEUE_KEY && code === 'REVISION_CONFLICT') {
          throw Object.assign(new Error('待处理队列已被其他窗口更新，请刷新页面后重试。'), { code })
        }
        const latest = domain === 'settings' ? await selected.readSettings() : domain === 'chat' ? await selected.readChat() : await selected.readDrafts(windowId)
        if (domain === 'draft' && !key.startsWith(CHAT_DRAFT_PREFIX)
          && (code === 'PROFILE_RESET_CONFLICT' || latest.resetRevision !== expectedReset)) {
          // Runtime chat reset preserves drawing/video/model drafts. Retry only
          // the reset token; retain CAS so an unrelated draft edit still conflicts.
          expectedReset = latest.resetRevision
          operationId = crypto.randomUUID()
          continue
        }
        const remote = latest.records.find(record => record.key === key)
        if ((domain === 'chat' || key.startsWith(CHAT_DRAFT_PREFIX)) && latest.resetRevision !== expectedReset) {
          recovery.set(identity, { key, value, reason: 'chat-reset' })
          const chat = domain === 'chat' ? latest : await selected.readChat()
          for (const [entryId, record] of values) if (profileDomainForKey(record.key) === 'chat' || record.key.startsWith('aics_chat_draft_v1:')) {
            values.delete(entryId); revisions.delete(entryId)
          }
          take(chat)
          snapshotVersions = { ...snapshotVersions, chat: undefined, draft: undefined }
          for (const record of chat.records) revisions.set(cacheKey(record.key, false), record.revision)
          window.dispatchEvent(new StorageEvent('storage', { key: 'aics_chat_v1' }))
          window.dispatchEvent(new CustomEvent('huiyu:profile-write-error', { detail: '另一窗口已清空聊天，旧内容未重新写入；可导出本页未保存草稿。' }))
          return 'recovered'
        }
        const { mergeProfileChatConflict, mergeProfileSettingConflict } = await import('./profileConflict.ts')
        if (domain === 'chat') sendValue = await mergeProfileChatConflict(key, baseValue, sendValue, remote?.value ?? null)
        else if (domain === 'settings') sendValue = mergeProfileSettingConflict(key, baseValue, sendValue, remote?.value ?? null)
        baseValue = structuredClone(remote?.value ?? null)
        expectedRevision = remote?.revision ?? null
        // A 409 proved this operation did not commit. Only this branch may use a
        // new identity/input; network-unknown retries keep their original pair.
        operationId = crypto.randomUUID()
      }
    }
    throw new Error('其他窗口正在修改同一资料，请稍后重试；当前编辑已保留。')
  } })
  drain()
  return delivery.receipt
}
function drain() {
  if (draining || failure || connectionBlocked) return
  draining = true
  pending = (async () => {
    try {
      while (outbox.length) {
        assertProfileWritable()
        const entry = outbox[0], outcome = await entry.run()
        outbox.shift()
        if (outcome === 'confirmed') entry.delivery.confirmed()
        else entry.delivery.failed(new Error('另一窗口已清空聊天；本次内容保留在恢复草稿中，未重新写入。'), true)
      }
    }
    catch (error) {
      outbox[0]?.delivery.failed(error)
      for (const entry of outbox) entry.delivery.block(error)
      publishError(error)
    }
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
  const refresh = ++refreshVersion
  await flushProfileWrites()
  if (refresh !== refreshVersion) return
  const current = generation, writes = writeVersion, known = snapshotVersions
  const archiveIdentity = cacheKey('aics_chat_archive_v1', false), archive = values.get(archiveIdentity)
  const archiveVersion = archive && !optimisticRecords.has(archive) ? archive.version : undefined
  const [settings, chat, drafts] = await Promise.all([port.readSettings(known.settings), port.readChat(known.chat, archiveVersion), port.readDrafts(windowId, known.draft)])
  // A save may have started AND drained while these snapshots were in flight.
  // A later refresh captures the new write version and can publish normally.
  if (current !== generation || refresh !== refreshVersion || writes !== writeVersion || known !== snapshotVersions || outbox.length) return
  // Never pair pre-reset chat drafts with a newer chat reset fence. The next
  // health sync retries the whole snapshot without publishing partial data.
  if (settings.resetRevision !== chat.resetRevision || drafts.resetRevision !== chat.resetRevision) throw new Error('聊天资料在同步期间被清空，请重新读取。')
  if (chat.unchangedArchive !== undefined && (!archiveVersion || chat.unchangedArchive !== archiveVersion
    || values.get(archiveIdentity) !== archive || chat.resetRevision !== resetRevision)) throw new Error('聊天归档在同步期间已变化，请重新读取。')
  if (settings.unchanged && chat.unchanged && drafts.unchanged) return
  const retainedArchive = chat.unchangedArchive === undefined ? undefined : archive
  const snapshots = { settings, chat, draft: drafts }
  const changedDomain = (record: ProfileRecord) => {
    const domain = profileDomainForKey(record.key)
    // Retain both the confirmed record and its CAS revision. This also skips
    // serializing the large archive again in the change-notification pass.
    return record !== retainedArchive && domain !== null && !snapshots[domain].unchanged
  }
  const before = new Map([...values].map(([identity, record]) => [identity, record.value]))
  for (const [identity, record] of values) if (changedDomain(record)) { values.delete(identity); revisions.delete(identity) }
  if (!settings.unchanged) take(settings)
  if (!chat.unchanged) take(chat)
  for (const record of drafts.unchanged ? [] : drafts.records) {
    const session = !record.key.startsWith('aics_chat_draft_v1:') && !record.key.startsWith('aics-model-draft-') && record.key !== 'aics_pb_last_draft'
    values.set(cacheKey(record.key, session), record)
  }
  // A reset between these three reads must not give old chat data a newer
  // reset fence. As before, the chat snapshot alone owns this token.
  resetRevision = chat.resetRevision
  const changedKeys: string[] = []
  for (const [identity, record] of values) {
    if (!changedDomain(record)) continue
    revisions.set(identity, record.revision)
    const previous = before.get(identity)
    // Most profiles already contain JSON text. Re-encoding both strings makes
    // two escaped copies of large chat archives just to detect a change.
    const changed = typeof previous === 'string' && typeof record.value === 'string'
      ? previous !== record.value : JSON.stringify(previous) !== JSON.stringify(record.value)
    if (changed) changedKeys.push(record.key)
  }
  // Listeners can synchronously queue writes; publish all CAS revisions and
  // versions first so their new invalidations are never overwritten.
  snapshotVersions = { settings: settings.version, chat: chat.version, draft: drafts.version }
  for (const key of changedKeys) window.dispatchEvent(new StorageEvent('storage', { key }))
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

/** Explicit mutations for new consumers. Storage setters above remain optimistic compatibility reads/writes. */
export function writeProfileValue(key: string, value: string | null, session = false): ProfileWriteReceipt {
  const domain = profileDomainForKey(key)
  if (port && domain) return queueWrite(domain, key, value, session)
  assertProfileWritable()
  const storage = session ? globalThis.sessionStorage : globalThis.localStorage
  if (value === null) storage.removeItem(key)
  else storage.setItem(key, value)
  const delivery = createProfileWriteReceipt(key, () => {})
  delivery.confirmed()
  return delivery.receipt
}
export const writeProfileLocal = (key: string, value: string | null) => writeProfileValue(key, value)
export const writeProfileDraft = (key: string, value: string | null) => writeProfileValue(key, value, true)
/** Capture the current operations for these keys; preserve FIFO without waiting for unrelated successors. */
export async function confirmProfileKeys(keys: readonly string[], session = false): Promise<void> {
  await Promise.all(keys.map(key => latestWrites.get(cacheKey(key, session))?.confirm()))
}

export async function readProfileChatArchive(): Promise<unknown> {
  if (!port) throw new Error('Profile runtime is not active')
  await flushProfileWrites()
  const current = generation, writes = writeVersion, refresh = refreshVersion
  const identity = cacheKey('aics_chat_archive_v1', false)
  const cached = values.get(identity)
  const known = cached && !optimisticRecords.has(cached) ? cached.version : undefined
  const snapshot = await port.readChatArchive(known)
  const record = snapshot.unchanged ? cached : snapshot.records.find(record => record.key === 'aics_chat_archive_v1')
  if (current !== generation || writes !== writeVersion || refresh !== refreshVersion || outbox.length
    || (snapshot.unchanged && values.get(identity) !== cached)
    || snapshot.resetRevision !== resetRevision || (record?.revision ?? 0) < (revisions.get(identity) ?? 0)) {
    throw new Error('聊天资料已变化，请重新读取归档。')
  }
  if (!snapshot.unchanged) {
    if (record) { values.set(identity, structuredClone(record)); revisions.set(identity, record.revision) }
    else { values.delete(identity); revisions.delete(identity) }
    snapshotVersions = { ...snapshotVersions, chat: undefined }
  }
  // A cache hit must not expose the private confirmed object to archive edits.
  const value = record?.value ?? null
  return typeof value === 'string' ? JSON.parse(value) as unknown : snapshot.unchanged ? structuredClone(value) : value
}
export async function writeProfileChatArchive(value: unknown): Promise<void> {
  if (!port) throw new Error('Profile runtime is not active')
  await flushProfileWrites()
  await queueWrite('chat', 'aics_chat_archive_v1', value, false).confirm()
}
export async function resetProfileChat(): Promise<void> {
  assertProfileWritable()
  if (!port) throw new Error('Profile runtime is not active')
  await flushProfileWrites()
  const snapshot = await port.resetChat({ operationId: crypto.randomUUID(), expectedReset: resetRevision })
  writeVersion++
  snapshotVersions = { ...snapshotVersions, chat: undefined, draft: undefined }
  for (const [identity, record] of values) if (profileDomainForKey(record.key) === 'chat' || record.key.startsWith('aics_chat_draft_v1:')) {
    values.delete(identity); revisions.delete(identity)
  }
  take(snapshot)
  for (const record of snapshot.records) revisions.set(cacheKey(record.key, false), record.revision)
}

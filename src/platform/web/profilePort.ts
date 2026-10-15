import type { ProfileRecord, ProfileSnapshot } from '../../../types/profile'
import type { ProfilePort } from './profileStorage'

/** A narrow domain adapter; callers cannot issue arbitrary key/value commands. */
export function createProfilePort(request: <T>(command: Record<string, unknown>) => Promise<T>): ProfilePort {
  const save = async (kind: string, input: Record<string, unknown> & { key: string; value: unknown }): Promise<ProfileRecord> => {
    // The outbox owns a detached JSON value and keeps it unchanged until this
    // attempt settles. Rebuild from that input, never the newer optimistic cache.
    const { key, value } = input
    const saved = await request<Pick<ProfileRecord, 'key' | 'revision' | 'version'>>({ kind, ...input, ackOnly: true })
    if (saved.key !== key || !Number.isSafeInteger(saved.revision) || saved.revision < 1) throw new Error('资料保存回执无效，请重新连接。')
    return { key, value: structuredClone(value), revision: saved.revision, version: saved.version }
  }
  const read = async (kind: string, ifVersion?: string, options: { windowId?: string; ifArchiveVersion?: string } = {}): Promise<ProfileSnapshot> => {
    const snapshot = await request<ProfileSnapshot>({ kind, ...(ifVersion === undefined ? {} : { ifVersion }), ...options })
    if (snapshot.unchanged && (!ifVersion || snapshot.version !== ifVersion || snapshot.records.length !== 0)) throw new Error('资料快照版本无效，请重新读取。')
    if (snapshot.unchangedArchive !== undefined && (kind !== 'profile.readChat' || snapshot.unchanged
      || !options.ifArchiveVersion || snapshot.unchangedArchive !== options.ifArchiveVersion
      || snapshot.records.some(record => record.key === 'aics_chat_archive_v1'))) throw new Error('聊天归档快照版本无效，请重新读取。')
    return snapshot
  }
  return {
    readSettings: ifVersion => read('profile.readSettings', ifVersion),
    saveSetting: input => save('profile.saveSetting', input),
    readChat: (ifVersion, ifArchiveVersion) => read('profile.readChat', ifVersion, ifArchiveVersion === undefined ? {} : { ifArchiveVersion }),
    readChatArchive: ifVersion => read('profile.readChatArchive', ifVersion),
    saveChatRecord: input => save('profile.saveChatRecord', input),
    resetChat: input => request<ProfileSnapshot>({ kind: 'profile.resetChat', ...input }),
    readDrafts: (windowId, ifVersion) => read('profile.readDrafts', ifVersion, { windowId }),
    saveDraft: input => save('profile.saveDraft', input),
  }
}

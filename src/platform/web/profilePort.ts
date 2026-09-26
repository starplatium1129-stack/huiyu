import type { ProfileRecord, ProfileSnapshot } from '../../../types/profile'
import type { ProfilePort } from './profileStorage'

/** A narrow domain adapter; callers cannot issue arbitrary key/value commands. */
export function createProfilePort(request: <T>(command: Record<string, unknown>) => Promise<T>): ProfilePort {
  return {
    readSettings: () => request<ProfileSnapshot>({ kind: 'profile.readSettings' }),
    saveSetting: input => request<ProfileRecord>({ kind: 'profile.saveSetting', ...input }),
    readChat: () => request<ProfileSnapshot>({ kind: 'profile.readChat' }),
    saveChatRecord: input => request<ProfileRecord>({ kind: 'profile.saveChatRecord', ...input }),
    resetChat: input => request<ProfileSnapshot>({ kind: 'profile.resetChat', ...input }),
    readDrafts: windowId => request<ProfileSnapshot>({ kind: 'profile.readDrafts', windowId }),
    saveDraft: input => request<ProfileRecord>({ kind: 'profile.saveDraft', ...input }),
  }
}

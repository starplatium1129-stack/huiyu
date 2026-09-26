import type { ProfileRecord, ProfileSnapshot } from '../../types/profile';
export type ProfileCommand =
  | { kind: 'profile.readSettings' }
  | { kind: 'profile.saveSetting'; operationId: string; key: string; value: string | null; expectedRevision: number | null }
  | { kind: 'profile.readChat' }
  | { kind: 'profile.saveChatRecord'; operationId: string; key: string; value: unknown; expectedRevision: number | null; expectedReset: string }
  | { kind: 'profile.resetChat'; operationId: string; expectedReset: string }
  | { kind: 'profile.readDrafts'; windowId: string }
  | { kind: 'profile.saveDraft'; operationId: string; key: string; value: string | null; windowId?: string; expectedRevision: number | null; expectedReset: string };
export interface ProfileResults {
  'profile.readSettings': ProfileSnapshot;
  'profile.saveSetting': ProfileRecord;
  'profile.readChat': ProfileSnapshot;
  'profile.saveChatRecord': ProfileRecord;
  'profile.resetChat': ProfileSnapshot;
  'profile.readDrafts': ProfileSnapshot;
  'profile.saveDraft': ProfileRecord;
}
export type ProfileResult = ProfileResults[keyof ProfileResults];

export type ProfileDomain = 'settings' | 'chat' | 'draft'
export interface ProfileRecord { key: string; value: unknown; revision: number }
export interface ProfileSnapshot { records: ProfileRecord[]; revision: number; resetRevision: string }

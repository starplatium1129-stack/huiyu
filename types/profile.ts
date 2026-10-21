export type ProfileDomain = 'settings' | 'chat' | 'draft'
export interface ProfileRecord { key: string; value: unknown; revision: number; version?: string }
export interface ProfileSnapshot { records: ProfileRecord[]; revision: number; resetRevision: string; version?: string; unchanged?: boolean; unchangedArchive?: string; archiveVersion?: string }

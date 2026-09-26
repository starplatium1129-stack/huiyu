export type MigrationDomain = 'artwork' | 'settings' | 'chat' | 'draft' | 'history' | 'quarantine' | 'transient' | 'credential' | 'unknown'
export type MigrationSource = 'kv' | 'local' | 'session'
export interface MigrationIdentity { sourceProfileId: string; origin: string; windowIds: string[] }
export interface MigrationRecord {
  source: MigrationSource
  key: string
  windowId?: string
  index?: number
  domain: MigrationDomain
  value: unknown
}
export interface MigrationRecordManifest { id: string; sha256: string; bytes?: number; source: MigrationSource; key: string; windowId?: string; index?: number; domain: MigrationDomain }
export interface MigrationMediaManifest { alias: string; sha256: string; bytes: number; mime: string; metadata: Record<string, unknown>; derived: boolean }
export interface MigrationEnvelope {
  format: 'huiyu-migration'
  version: 1
  migrationId: string
  source: MigrationIdentity
  createdAt: number
  records: MigrationRecordManifest[]
  media: MigrationMediaManifest[]
  blockers: string[]
  credentials: { references: string[]; verified: boolean }
  fingerprint: string
}
export interface MigrationStatus {
  migrationId: string
  workspaceId: string
  fingerprint: string
  source: MigrationIdentity
  state: 'importing' | 'verified' | 'activated'
  importedRecords: number
  totalRecords: number
  importedMedia: number
  totalMedia: number
  blockers: string[]
  domains: Array<'artwork' | 'settings' | 'chat' | 'draft'>
  revision: number
}

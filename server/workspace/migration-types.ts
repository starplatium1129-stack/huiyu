import type { MigrationEnvelope, MigrationRecord, MigrationStatus } from '../../types/migration';
export type MigrationCommand =
  | { kind: 'migration.begin'; operationId: string; envelope: MigrationEnvelope }
  | { kind: 'migration.record'; operationId: string; migrationId: string; itemId: string; record: MigrationRecord }
  | { kind: 'migration.recordChunk'; operationId: string; migrationId: string; itemId: string; offset: number; data: Uint8Array }
  | { kind: 'migration.media'; operationId: string; migrationId: string; alias: string; offset: number; data: Uint8Array }
  | { kind: 'migration.verify'; operationId: string; migrationId: string }
  | { kind: 'migration.status'; migrationId: string }
  | { kind: 'migration.activate'; operationId: string; migrationId: string; expectedFingerprint: string };
export interface MigrationResults {
  'migration.begin': MigrationStatus;
  'migration.record': { itemId: string; imported: boolean };
  'migration.recordChunk': { itemId: string; offset: number };
  'migration.media': { alias: string; offset: number };
  'migration.verify': MigrationStatus;
  'migration.status': MigrationStatus;
  'migration.activate': MigrationStatus;
}
export type MigrationResult = MigrationResults[keyof MigrationResults];

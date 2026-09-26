export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type EntityId = string | number;
export type WorkspaceBody = { id: EntityId; [key: string]: JsonValue };
export interface WorkspaceArtwork { id: EntityId; body: WorkspaceBody; revision: number; deletedAt: number | null }
export interface WorkspaceProject { id: EntityId; body: WorkspaceBody; revision: number }
export interface WorkspaceContext { principalId: string; workspaceId: string; protocolVersion: 1 }
export interface MediaInput { alias: string; sha256: string; bytes: number; mime: string }
export interface MutationReceipt {
  operationId: string;
  kind: string;
  revision: number;
  artwork?: WorkspaceArtwork;
  project?: WorkspaceProject;
  changed?: boolean;
  purged?: number;
  removed?: number;
  backupId?: string;
  candidateId?: string;
  mediaCount?: number;
}
export interface OperationState {
  operationId: string;
  kind: string;
  state: 'prepared' | 'committed' | 'aborted';
  revision: number | null;
  receipt?: MutationReceipt;
  media?: MediaInput & { writtenBytes: number };
}
export interface WorkspaceStatus {
  workspaceId: string;
  databaseKind: 'huiyu-workspace';
  schemaVersion: 1;
  revision: number;
  writerEpoch: string;
  sqliteVersion: string;
}
export type WorkspaceCommand =
  | { kind: 'status' }
  | { kind: 'listArtworks'; limit?: number; cursor?: string; includeDeleted?: boolean }
  | { kind: 'getArtwork'; id: EntityId }
  | { kind: 'listProjects' }
  | { kind: 'prepareSave'; operationId: string; artwork: WorkspaceBody; media: MediaInput }
  | { kind: 'uploadChunk'; operationId: string; offset: number; data: Uint8Array }
  | { kind: 'commitSave'; operationId: string }
  | { kind: 'abortSave'; operationId: string }
  | { kind: 'getOperation'; operationId: string }
  | { kind: 'patchArtwork'; operationId: string; id: EntityId; expectedRevision: number; patch: Record<string, JsonValue> }
  | { kind: 'softDeleteArtwork'; operationId: string; id: EntityId; expectedRevision: number }
  | { kind: 'restoreArtwork'; operationId: string; id: EntityId; expectedRevision: number }
  | { kind: 'saveProject'; operationId: string; project: WorkspaceBody; artworkIds: EntityId[]; expectedRevision: number | null }
  | { kind: 'purgeExpiredTrash'; operationId: string }
  | { kind: 'collectGarbage'; operationId: string }
  | { kind: 'readMedia'; alias: string; offset?: number; length?: number }
  | { kind: 'backup'; operationId: string }
  | { kind: 'restoreBackup'; operationId: string; backupId: string };

export interface WorkspaceResults {
  status: WorkspaceStatus;
  listArtworks: { items: WorkspaceArtwork[]; nextCursor: string | null; revision: number };
  getArtwork: WorkspaceArtwork | null;
  listProjects: { items: WorkspaceProject[]; revision: number };
  prepareSave: OperationState;
  uploadChunk: { operationId: string; offset: number };
  commitSave: MutationReceipt;
  abortSave: OperationState;
  getOperation: OperationState | null;
  patchArtwork: MutationReceipt;
  softDeleteArtwork: MutationReceipt;
  restoreArtwork: MutationReceipt;
  saveProject: MutationReceipt;
  purgeExpiredTrash: MutationReceipt;
  collectGarbage: MutationReceipt;
  readMedia: { data: Uint8Array; mime: string; totalBytes: number; sha256: string; offset: number };
  backup: { backupId: string; revision: number; mediaCount: number };
  restoreBackup: { candidateId: string; revision: number; mediaCount: number };
}
export type WorkspaceResult = WorkspaceResults[keyof WorkspaceResults];
export type Checkpoint = 'prepared' | 'media-published' | 'metadata-written' | 'committed';
export interface ExecuteOptions {
  isCancelled?: () => boolean;
  /** The worker may admit other operations once an immutable backup snapshot is ready. */
  onCopyReady?: () => void;
}

/** Codes cross the worker boundary; file paths and driver errors do not cross HTTP. */
export class WorkspaceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = 'WorkspaceError';
  }
}
export function isWorkspaceMutation(command: WorkspaceCommand): boolean {
  return !['status', 'listArtworks', 'getArtwork', 'listProjects', 'getOperation', 'readMedia'].includes(command.kind);
}

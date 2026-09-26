import type { TaskRecord, TaskList, TaskResultRef } from '../../types/tasks';
import type { MediaInput } from './types';
export type TaskPatch = Partial<Pick<TaskRecord, 'status' | 'recoveryState' | 'upstreamId' | 'provider' |
  'providerFingerprint' | 'submissionIntentAt' | 'submissionObservedAt' | 'upstreamSettled' |
  'resultState' | 'deliveryState' | 'errorCode' | 'metadata' | 'checkpoint' | 'input'>>;
export type TaskCommand =
  | TaskInputCommand
  | { kind: 'task.accept'; record: TaskRecord }
  | { kind: 'task.list' }
  | { kind: 'task.legacy-history' }
  | { kind: 'task.get'; taskId?: string; requestKey?: string }
  | { kind: 'task.patch'; taskId: string; expectedRevision: number; patch: TaskPatch }
  | { kind: 'task.cancel'; requestKey: string }
  | { kind: 'task.result.prepare'; taskId: string; media: TaskResultRef }
  | { kind: 'task.result.chunk'; taskId: string; index: number; offset: number; data: Uint8Array }
  | { kind: 'task.result.commit'; taskId: string; index: number };
export type TaskInputCommand =
  | { kind: 'task.input.prepare'; taskId: string; name: string; media: MediaInput }
  | { kind: 'task.input.chunk'; taskId: string; name: string; offset: number; data: Uint8Array }
  | { kind: 'task.input.commit'; taskId: string; name: string }
  | { kind: 'task.input.get'; taskId: string; name: string };
export interface TaskResults {
  'task.input.prepare': { offset: number };
  'task.input.chunk': { offset: number };
  'task.input.commit': MediaInput;
  'task.input.get': MediaInput | null;
  'task.accept': { task: TaskRecord; created: boolean };
  'task.list': TaskList;
  'task.legacy-history': { snapshots: unknown[] };
  'task.get': TaskRecord | null;
  'task.patch': TaskRecord;
  'task.cancel': TaskRecord | null;
  'task.result.prepare': { offset: number };
  'task.result.chunk': { offset: number };
  'task.result.commit': TaskRecord;
}
export type TaskResult = TaskResults[keyof TaskResults];

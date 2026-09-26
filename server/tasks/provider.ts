import type { TaskRecord, TaskStatus } from '../../types/tasks';
export type TaskOutput = ({ bytes: Uint8Array } | { file: string }) & { mime: string; index?: number };
export interface TaskObservation {
  status: TaskStatus; settled: boolean; unknown?: boolean; errorCode?: string | null;
  metadata?: Record<string, unknown>; outputs?: TaskOutput[]; checkpoint?: Record<string, unknown>;
}
export interface TaskExecutionHooks {
  /** This write must finish before the actual upstream POST. */
  submitting(provider: string, fingerprint: string): Promise<void>;
  observed(upstreamId: string, metadata?: Record<string, unknown>): Promise<void>;
  checkpoint(value: Record<string, unknown>): Promise<void>;
  collect(outputs: TaskOutput[]): Promise<void>;
  protectInput?(name: string, file: string): Promise<void>;
  restoreInput?(name: string, file: string): Promise<boolean>;
}
/** Recovery receives this restricted interface; there is deliberately no submit. */
export interface TaskRecoveryProvider {
  fingerprint(): string;
  query(task: TaskRecord): Promise<TaskObservation>;
  cancel(task: TaskRecord): Promise<void>;
}
export interface TaskProvider extends TaskRecoveryProvider {
  prepare?(task: TaskRecord, hooks: Pick<TaskExecutionHooks, 'protectInput' | 'restoreInput'>): Promise<void>;
  validate(input: Record<string, unknown>): Record<string, unknown>;
  submit(task: TaskRecord, hooks: TaskExecutionHooks): Promise<void>;
  action?(task: TaskRecord, name: string, hooks: TaskExecutionHooks): Promise<void>;
  close?(): void | Promise<void>;
}

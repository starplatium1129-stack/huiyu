export type TaskStatus = 'queued' | 'submitting' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';
export type TaskRecovery = 'normal' | 'reconciling' | 'unknown' | 'interrupted';
export interface TaskResultRef { alias: string; sha256: string; bytes: number; mime: string; index: number }
export interface TaskRecord {
  taskId: string; workspaceId: string; principalId: string; requestKey: string; requestFingerprint: string;
  kind: 'generation' | 'anima' | 'creative' | 'video' | 'batch';
  provider: string; providerFingerprint: string; upstreamId: string | null;
  status: TaskStatus; recoveryState: TaskRecovery; revision: number; runtimeEpoch: string;
  createdAt: number; updatedAt: number; submissionIntentAt: number | null;
  submissionObservedAt: number | null; cancelRequestedAt: number | null;
  upstreamSettled: boolean; executionDeadline: number; input: Record<string, unknown>; inputMediaRefs: string[];
  resultState: 'none' | 'collecting' | 'available' | 'unavailable'; resultRefs: TaskResultRef[];
  deliveryState: 'unseen' | 'seen' | 'saved' | 'discarded'; errorCode: string | null;
  metadata: Record<string, unknown>; checkpoint: Record<string, unknown> | null;
  parentBatchId: string | null; stepIndex: number | null;
}
export interface TaskSubmission { requestKey: string; kind: TaskRecord['kind']; input: Record<string, unknown>; context?: Record<string, unknown> }
export interface TaskList { items: TaskRecord[]; runtimeEpoch: string }

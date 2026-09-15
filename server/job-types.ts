export interface RegisteredJob {
  status: string;
}

export type JobTimer = ReturnType<typeof setTimeout>;
export type TimerSlots<Key extends PropertyKey> = { [Slot in Key]?: JobTimer | null };

/** The persisted summary deliberately excludes prompts, tokens and result bytes. */
export interface SnapshotInput {
  modelId?: string | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
}

export interface SnapshotJob {
  id: string;
  owner?: string | null;
  createdAt?: number;
  estimatedSeconds?: number | null;
  input?: SnapshotInput | null;
}

export interface JobSnapshot extends SnapshotJob {
  status: 'running';
}

export interface JobSnapshotStore {
  save(job: SnapshotJob): void;
  remove(id: unknown): void;
  drain(): JobSnapshot[];
}

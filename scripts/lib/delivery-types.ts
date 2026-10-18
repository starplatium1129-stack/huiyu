// Persisted JSON enters as unknown; these types describe validated records and
// values produced by the delivery tools, not unchecked JSON casts.
export type JsonRecord = Record<string, unknown>;
export type Machine = 'office' | 'main';
export type IdentityGroup = 'source' | 'build';
export type Selection = { path: string; kind: 'file' | 'tree' };
export type FileIdentity = { path: string; status: 'file'; bytes: number; sha256: string };
export type FileFailure = { path: string; status: 'missing' | 'unsafe-or-unreadable'; message: string };
export type SnapshotEntry = FileIdentity | {
  path: string;
  status: 'directory' | 'empty' | 'missing' | 'unsafe-or-unreadable' | 'not-directory';
  message?: string;
};
export type Snapshot = {
  selectors: Selection[];
  entries: SnapshotEntry[];
  status: 'complete' | 'incomplete';
  sha256: string;
};
export type SnapshotChange = {
  path: string; status: 'added' | 'removed' | 'changed'; before?: SnapshotEntry; after?: SnapshotEntry;
};
export type SnapshotComparison = {
  status: 'fresh' | 'stale' | 'unavailable'; expectedSha256: string; actualSha256: string;
  changes: SnapshotChange[]; problems: SnapshotEntry[]; current: Snapshot; message?: never;
} | { status: 'invalid'; message: string; changes: SnapshotChange[] };
export type Repository = {
  status: 'recorded'; commit: string; worktree: 'dirty' | 'clean';
} | { status: 'unknown'; commit: null; worktree: 'unknown'; message: string };
export type GateState = 'passed' | 'failed' | 'unknown' | 'unrun' | 'pending';
export type GateBinding = {
  dependsOn: IdentityGroup[]; identities: Partial<Record<IdentityGroup, string>>;
  machine: Machine; reports: FileIdentity[];
};
export type Tracking = {
  schemaVersion: 1; algorithm: 'sha256'; source: Snapshot; build: Snapshot; gates: Record<string, GateBinding>;
};
export type TrackedDocument = JsonRecord & { tracking: Tracking };
export type ReadRecord<T = JsonRecord> = { value: T; entry: FileIdentity };
export type GateInspection = {
  status: 'unknown' | 'invalid' | 'fresh' | 'stale'; declaredStatus: GateState;
  effectiveStatus: GateState | 'stale'; message?: string; dependsOn?: IdentityGroup[]; machine?: Machine;
  reports: { path: string; status: 'fresh' | 'stale'; expectedSha256: string; actual: FileIdentity | FileFailure }[];
};
export type TrackingInspection = {
  status: 'unknown' | 'invalid' | 'fresh' | 'stale'; message?: string;
  source?: SnapshotComparison; build?: SnapshotComparison; gates: Record<string, GateInspection>;
  finalization?: FinalizationInspection | null;
};
export type GitFile = { path: string; mode: string; oid: string; bytes: number };
export type SourceProof = {
  tree: string;
  files: (GitFile & { blobSha256: string; sourceSha256: string; representation: 'exact' | 'git-crlf-to-lf' })[];
  indexSha256: string; scope: 'selected-source-only'; buildCommitCoverage: 'not-asserted';
};
export type GateOrigin = { executionCommit: string; valueSha256: string; bindingSha256: string; resultRecord?: FileIdentity };
export type Finalization = {
  schemaVersion: 1; baselineHead: string; finalCommit: string; previousCommit: string;
  baseline: FileIdentity; evidence: FileIdentity; lineage: FileIdentity[]; resultRecord?: FileIdentity;
  sourceSha256: string; buildSha256: string; sourceProof: SourceProof; gates: Record<string, GateOrigin>;
  worktree: { baseline: unknown; final: Repository['worktree']; source: 'matches-final-commit';
    sourceIndex: 'matches-final-commit'; scope: 'selected-source-only' };
};
export type FinalizationInspection = {
  status: 'matched'; baselineHead: string; finalCommit: string; worktree: JsonRecord;
  sourceProof: SourceProof; gates: Record<string, GateOrigin>;
} | { status: 'invalid'; message: string };
export type MainRequirement = { field: string; machine: 'main'; action: string };
export type HandoffInspection = {
  status: 'pending' | 'failed' | 'passed'; errors: string[]; pending: string[];
  source?: SnapshotComparison; build?: SnapshotComparison; stage?: Machine;
  environment?: JsonRecord; install?: JsonRecord;
  requiredMain?: (MainRequirement & { status: GateState | 'stale' })[];
  commit?: { expected: unknown; actual: string | null; status: 'unknown' | 'matched' | 'mismatch' };
  finalization?: FinalizationInspection | null;
};
export type CaptureOptions = {
  machine?: string; baseline?: string; record?: string; scope?: string; finalizeCommit?: string;
  source: Selection[]; build: Selection[]; gates: Record<string, IdentityGroup[]>;
};
export type AuditEntry = { file?: string; field?: string; message: unknown; status?: string };
export type AuditIdentity = { files: string[]; ids: Record<string, string> };
export type AuditComparison = {
  file: string; status: 'failed' | 'matched'; sharedIds: string[]; primary?: AuditIdentity; other?: AuditIdentity; message?: string;
};
export type VerifiedFile = {
  file: string; expectedSha256?: string; actualSha256?: string; realPath?: string; message?: string;
  status?: 'outside-root' | 'not-file' | 'mismatch' | 'matched' | 'exists' | 'missing' | 'error';
};
export type RepositoryHead = {
  root: string; commit: string | null; evidenceCommit: unknown;
  status: 'pending' | 'unavailable' | 'missing-commit' | 'mismatch' | 'matched'; message?: string;
};
export type RepositoryWorktree = {
  root: string; status: 'unavailable' | 'dirty' | 'clean'; rawPorcelain?: string; message?: string;
  changedFiles: { kind: 'untracked' | 'uncommitted'; indexStatus: string; worktreeStatus: string; pathPorcelain: string; raw: string }[];
};
export type AuditRecord = { file: string; commit: unknown; baseline: unknown; scope: unknown; environment: unknown };
export type AuditRecommendation = { name: string; command: string[] | null | undefined; nature: string[]; executed: false };
export type AuditDetails = {
  schemaVersion: 1; passed: AuditEntry[]; pending: AuditEntry[]; limitations: AuditEntry[];
  records: AuditRecord[]; recommendations: AuditRecommendation[]; verifiedFiles: VerifiedFile[];
  comparisons?: AuditComparison[]; repositoryHead?: RepositoryHead; repositoryWorktree?: RepositoryWorktree;
  freshness?: TrackingInspection; handoff?: HandoffInspection | null;
};
export type AuditReport = Partial<AuditDetails> & { status: 'failed' | 'pending' | 'passed'; exitCode: number; errors: AuditEntry[] };

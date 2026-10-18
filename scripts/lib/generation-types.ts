export type GenerationOptions = { signal?: AbortSignal; pollMs?: number; timeoutMs?: number };
export type GatewayRecord = {
  gateway: string; payload: Record<string, unknown>; status: string; jobId?: string | null; seed?: unknown;
  serverMetadata?: unknown; serverCode?: unknown; serverError?: unknown;
  resultUrl?: string; provider?: string; actualSeed?: unknown;
};
export type CandidateRecord = GatewayRecord & Record<string, unknown> & {
  schemaVersion: 1; runId: string; generator: string; candidateId: string; key: string; recordId: string;
  attempt: number; createdAt: string; payloadSha256: string; image: string;
  review: { verdict: 'pending'; recordId: string; reviewedAt?: unknown };
};
export type CandidateTask = {
  key: string;
  metadata: Record<string, unknown> & { batch: 'reference' | 'popular' | 'scene' };
  payload: (attempt: number) => Record<string, unknown> & { seed: number };
};
export type CandidateOptions = {
  help?: false; env: NodeJS.ProcessEnv; root: string; gateway: string; dryRun: boolean;
  retryUnknown: boolean; output: string | null; concurrency: number; force?: boolean;
};
export type CandidateSource = { path: string; bytes: number; sha256: string };

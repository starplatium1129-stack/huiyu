export type ManifestEntry = { path: string; bytes: number; sha256: string };
export type ResourceManifest = { schemaVersion: 1; entries: ManifestEntry[]; unverified?: unknown[] };
export type ManifestIssue = {
  code: string;
  message: string;
  path?: string;
  count?: number;
  expected?: number | string;
  actual?: number | string;
};
export type DeltaTotals = { added: number; removed: number; changed: number; unchanged: number };
export type ManifestIdentity = { path: string; contentIdentity: string; entryCount: number; totalBytes: number };
export type DeltaMetadata = {
  schemaVersion: 1;
  kind: 'resource-pack-delta';
  baseManifest: ManifestIdentity;
  newManifest: ManifestIdentity;
  totals: DeltaTotals;
  removed: ManifestEntry[];
  candidate: { files: number; bytes: number; zeroAssets: boolean };
};

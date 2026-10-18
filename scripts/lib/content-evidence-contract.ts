'use strict';
const { object, validId }: typeof import('./content-history-reader') = require('./content-history-reader');
const { SHA, jsonHash, evidencePath }: typeof import('./content-evidence-io') = require('./content-evidence-io');
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const STATES = ['planned', 'succeeded', 'failed', 'invalid-asset', 'interrupted', 'submission-unknown', 'recoverable', 'submitting', 'submitted', 'running', 'downloading'];
// Exact metadata insertion order in the three current generation adapters.
// Unknown generators keep version derivation unknown; never execute their recipe.
const METADATA: Record<string, readonly string[]> = {
  'render-all-outfits-references.js': ['batch', 'engine', 'characterId', 'charName', 'outfitId', 'outfitName', 'persId', 'persName', 'intendedReferencePath'],
  'render-showcase-gaps.js': ['batch', 'engine', 'characterId', 'blueprintId', 'blueprintTitle', 'outfitId', 'title', 'story', 'category', 'displayName', 'rating', 'adult', 'intendedEntryId', 'sourceManifest'],
  'generate-all-scenes-showcase-miaomiao.js': ['batch', 'engine', 'characterId', 'blueprintId', 'blueprintTitle', 'sceneId', 'outfitId', 'adult', 'title', 'story', 'category', 'rating', 'checkpoint', 'intendedEntryId'],
};

type Source = { path: string; sha256: string; bytes: number };
type CandidateRecord = Record<string, unknown> & {
  schemaVersion: 1; runId: string; generator: string; candidateId: string; key: string; attempt: number; recordId: string;
  status: string; batch: 'reference' | 'popular' | 'scene'; inputVersion: string; payloadSha256: string; payload: Record<string, unknown>;
  sources: Source[]; recipeSource: Record<string, unknown> & { path: string; sha256: string }; image: string;
  review: { verdict: 'pending'; recordId: string; reviewedAt?: unknown }; asset?: Source;
};
function validateRecord(record: unknown, marker: { runId: string; generator: string }): CandidateRecord {
  if (!object(record) || record.schemaVersion !== 1 || record.runId !== marker.runId || record.generator !== marker.generator
    || typeof record.candidateId !== 'string' || !UUID.test(record.candidateId) || !validId(record.key) || typeof record.attempt !== 'number' || !Number.isSafeInteger(record.attempt) || record.attempt < 1
    || record.recordId !== `${record.key}@attempt-${record.attempt}-${record.candidateId}`
    || typeof record.status !== 'string' || !STATES.includes(record.status) || typeof record.batch !== 'string' || !['reference', 'popular', 'scene'].includes(record.batch)
    || typeof record.inputVersion !== 'string' || !SHA.test(record.inputVersion) || typeof record.payloadSha256 !== 'string' || !SHA.test(record.payloadSha256) || !object(record.payload)
    || !Array.isArray(record.sources) || !record.sources.length || record.sources.some((source: unknown) => !object(source)
      || typeof source.path !== 'string' || typeof source.sha256 !== 'string' || !SHA.test(source.sha256) || typeof source.bytes !== 'number' || !Number.isSafeInteger(source.bytes) || source.bytes < 0)
    || !object(record.recipeSource) || typeof record.recipeSource.sha256 !== 'string' || !SHA.test(record.recipeSource.sha256) || typeof record.recipeSource.path !== 'string'
    || record.image !== `images/${record.candidateId}.png`
    || !object(record.review) || record.review.verdict !== 'pending' || record.review.recordId !== record.recordId || record.review.reviewedAt || record.publishedAt) {
    throw new Error('Invalid candidate identity, container, source declarations or inline review state');
  }
  evidencePath(record.image);
  if (new Set(record.sources.map((source: Source) => source.path)).size !== record.sources.length) throw new Error('Duplicate candidate source declarations');
  if (record.asset !== undefined && (!object(record.asset) || record.asset.path !== record.image
    || typeof record.asset.sha256 !== 'string' || !SHA.test(record.asset.sha256) || typeof record.asset.bytes !== 'number' || !Number.isSafeInteger(record.asset.bytes) || record.asset.bytes <= 0)) throw new Error('Invalid candidate asset evidence');
  return record as CandidateRecord;
}

function inputVersion(record: CandidateRecord) {
  const keys = Object.hasOwn(METADATA, record.generator) ? METADATA[record.generator] : null;
  if (!keys) return { status: 'unknown', reason: 'Generator metadata mapping is not implemented' };
  const metadata = Object.fromEntries(keys.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]));
  const { seed: ignoredSeed, ...recipe } = record.payload;
  void ignoredSeed;
  const expected = jsonHash({ sources: record.sources, recipeSource: record.recipeSource, key: record.key, metadata, recipe });
  return { status: expected === record.inputVersion ? 'verified' : 'mismatch', expected, actual: record.inputVersion,
    rule: 'generation-candidates.runCandidates: sources/recipeSource/key/metadata/recipe without seed' };
}

function reviewState(record: CandidateRecord, integrity: string, decisionFile: ReturnType<typeof validateDecisions> | null, manifestSha256: string, runId: string) {
  if (!decisionFile) return { status: 'pending', authenticity: 'unverified' };
  const decision = decisionFile.records[record.key];
  if (!decision) return { status: 'pending', authenticity: 'unverified' };
  if (!object(decision) || (decision.verdict !== 'pass' && decision.verdict !== 'fail') || typeof decision.reviewedAt !== 'string'
    || !Number.isFinite(Date.parse(decision.reviewedAt))) return { status: 'invalid', reason: 'Invalid explicit human decision metadata', authenticity: 'unverified' };
  const binding = { recordId: record.recordId, recordSha256: jsonHash(record), sha256: record.asset?.sha256, inputVersion: record.inputVersion };
  const stale = decisionFile.manifestSha256 !== manifestSha256 || decisionFile.runId !== runId
    || Object.entries(binding).some(([key, value]) => !value || decision[key] !== value) || integrity !== 'current';
  return { status: stale ? 'stale' : decision.verdict === 'pass' ? 'approved' : 'rejected',
    verdict: decision.verdict, reviewedAt: decision.reviewedAt, authenticity: 'unverified',
    reason: stale ? 'Candidate, source, request or asset changed; decision requires revalidation' : 'Explicit decision bindings match; audit does not authenticate the reviewer or image quality' };
}

function validateDecisions(value: unknown) {
  if (!object(value) || value.schemaVersion !== 1 || typeof value.kind !== 'string' || !['content-human-review', 'reference-human-review'].includes(value.kind)
    || typeof value.runId !== 'string' || !UUID.test(value.runId) || typeof value.manifestSha256 !== 'string' || !SHA.test(value.manifestSha256) || !object(value.records)) throw new Error('Unsupported human-decision file');
  return { ...value, runId: value.runId, manifestSha256: value.manifestSha256, records: value.records };
}

export = { UUID, validateRecord, inputVersion, reviewState, validateDecisions };

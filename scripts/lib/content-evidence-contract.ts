'use strict';
const { object, validId }: typeof import('./content-history-reader') = require('./content-history-reader');
const { SHA, jsonHash, evidencePath }: typeof import('./content-evidence-io') = require('./content-evidence-io');
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const STATES = ['planned', 'succeeded', 'failed', 'invalid-asset', 'interrupted', 'submission-unknown', 'recoverable', 'submitting', 'submitted', 'running', 'downloading'];
// Exact metadata insertion order in the three current generation adapters.
// Unknown generators keep version derivation unknown; never execute their recipe.
const METADATA = {
  'render-all-outfits-references.js': ['batch', 'engine', 'characterId', 'charName', 'outfitId', 'outfitName', 'persId', 'persName', 'intendedReferencePath'],
  'render-showcase-gaps.js': ['batch', 'engine', 'characterId', 'blueprintId', 'blueprintTitle', 'outfitId', 'title', 'story', 'category', 'displayName', 'rating', 'adult', 'intendedEntryId', 'sourceManifest'],
  'generate-all-scenes-showcase-miaomiao.js': ['batch', 'engine', 'characterId', 'blueprintId', 'blueprintTitle', 'sceneId', 'outfitId', 'adult', 'title', 'story', 'category', 'rating', 'checkpoint', 'intendedEntryId'],
};

function validateRecord(record: { schemaVersion: number; runId: unknown; generator: unknown; candidateId: string; key: string; attempt: unknown; recordId: string; status: string; batch: string; inputVersion: string; payloadSha256: string; payload: null; sources: unknown[]; recipeSource: { sha256: string; path: unknown; }|null; image: string; review: { verdict: string; recordId: unknown; reviewedAt: unknown; }; publishedAt: unknown; asset: { path: unknown; sha256: string; bytes: unknown; }|null|undefined; }|null, marker: { runId: unknown; generator: unknown; }) {
  if (!object(record) || record.schemaVersion !== 1 || record.runId !== marker.runId || record.generator !== marker.generator
    || !UUID.test(record.candidateId) || !validId(record.key) || !Number.isSafeInteger(record.attempt) || record.attempt < 1
    || record.recordId !== `${record.key}@attempt-${record.attempt}-${record.candidateId}`
    || !STATES.includes(record.status) || !['reference', 'popular', 'scene'].includes(record.batch)
    || !SHA.test(record.inputVersion) || !SHA.test(record.payloadSha256) || !object(record.payload)
    || !Array.isArray(record.sources) || !record.sources.length || record.sources.some((source: { path: unknown; sha256: string; bytes: unknown; }|null) => !object(source)
      || typeof source.path !== 'string' || !SHA.test(source.sha256) || !Number.isSafeInteger(source.bytes) || source.bytes < 0)
    || !object(record.recipeSource) || !SHA.test(record.recipeSource.sha256) || typeof record.recipeSource.path !== 'string'
    || record.image !== `images/${record.candidateId}.png`
    || record.review?.verdict !== 'pending' || record.review.recordId !== record.recordId || record.review.reviewedAt || record.publishedAt) {
    throw new Error('Invalid candidate identity, container, source declarations or inline review state');
  }
  evidencePath(record.image);
  if (new Set(record.sources.map((source: { path: unknown; }) => source.path)).size !== record.sources.length) throw new Error('Duplicate candidate source declarations');
  if (record.asset !== undefined && (!object(record.asset) || record.asset.path !== record.image
    || !SHA.test(record.asset.sha256) || !Number.isSafeInteger(record.asset.bytes) || record.asset.bytes <= 0)) throw new Error('Invalid candidate asset evidence');
}

function inputVersion(record: object) {
  const keys = Object.hasOwn(METADATA, record.generator) ? METADATA[record.generator] : null;
  if (!keys) return { status: 'unknown', reason: 'Generator metadata mapping is not implemented' };
  const metadata = Object.fromEntries(keys.filter((key: PropertyKey) => Object.hasOwn(record, key)).map((key: string|number) => [key, record[key]]));
  const { seed: ignoredSeed, ...recipe } = record.payload;
  void ignoredSeed;
  const expected = jsonHash({ sources: record.sources, recipeSource: record.recipeSource, key: record.key, metadata, recipe });
  return { status: expected === record.inputVersion ? 'verified' : 'mismatch', expected, actual: record.inputVersion,
    rule: 'generation-candidates.runCandidates: sources/recipeSource/key/metadata/recipe without seed' };
}

function reviewState(record: string[], integrity: string, decisionFile: { records: { [x: string]: unknown; }; manifestSha256: unknown; runId: unknown; }, manifestSha256: unknown, runId: unknown) {
  if (!decisionFile) return { status: 'pending', authenticity: 'unverified' };
  const decision = decisionFile.records[record.key];
  if (!decision) return { status: 'pending', authenticity: 'unverified' };
  if (!object(decision) || !['pass', 'fail'].includes(decision.verdict) || typeof decision.reviewedAt !== 'string'
    || !Number.isFinite(Date.parse(decision.reviewedAt))) return { status: 'invalid', reason: 'Invalid explicit human decision metadata', authenticity: 'unverified' };
  const binding = { recordId: record.recordId, recordSha256: jsonHash(record), sha256: record.asset?.sha256, inputVersion: record.inputVersion };
  const stale = decisionFile.manifestSha256 !== manifestSha256 || decisionFile.runId !== runId
    || Object.entries(binding).some(([key, value]) => !value || decision[key] !== value) || integrity !== 'current';
  return { status: stale ? 'stale' : decision.verdict === 'pass' ? 'approved' : 'rejected',
    verdict: decision.verdict, reviewedAt: decision.reviewedAt, authenticity: 'unverified',
    reason: stale ? 'Candidate, source, request or asset changed; decision requires revalidation' : 'Explicit decision bindings match; audit does not authenticate the reviewer or image quality' };
}

function validateDecisions(value: { schemaVersion: number; kind: string; runId: string; manifestSha256: string; records: null; }|null) {
  if (!object(value) || value.schemaVersion !== 1 || !['content-human-review', 'reference-human-review'].includes(value.kind)
    || !UUID.test(value.runId) || !SHA.test(value.manifestSha256) || !object(value.records)) throw new Error('Unsupported human-decision file');
  return value;
}

export = { UUID, METADATA, validateRecord, inputVersion, reviewState, validateDecisions };

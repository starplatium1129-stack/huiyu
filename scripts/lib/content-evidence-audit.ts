import { PathLike } from 'node:fs';
import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage } from './runtime-errors';
'use strict';
const path: typeof import('node:path') = require('node:path');
const { isDeepStrictEqual: equal }: typeof import('node:util') = require('node:util');
const { object }: typeof import('./content-history-reader') = require('./content-history-reader');
const { hash, jsonHash, SHA, evidencePath, evidenceReader, explicitSource }: typeof import('./content-evidence-io') = require('./content-evidence-io');
const { UUID, validateRecord, inputVersion, reviewState, validateDecisions }: typeof import('./content-evidence-contract') = require('./content-evidence-contract');

function sourceEvidence(record: { sources: unknown[]; recipeSource: unknown; }, reader: { root: unknown; bytes: unknown; fingerprint?: (file: unknown,limit: number|undefined) => { bytes: unknown; sha256: unknown; }; json?: (file: string) => unknown; list?: (directory: string) => unknown[]; evidence?: () => ({ scope: unknown; file: unknown; status: unknown; sha256: unknown; bytes: unknown; }|{ scope: unknown; file: unknown; kind: string; sha256: string; })[]; verify?: () => string[]; }, options: { sources: unknown; recipe: unknown; }) {
  const files = [];
  for (const [role, declaration, allowed] of [
    ...record.sources.map((source: unknown) => ['source', source, options.sources || []]),
    ['recipe', record.recipeSource, options.recipe ? [options.recipe] : []],
  ]) {
    const file = explicitSource(reader.root, declaration.path, allowed);
    const item = { role, file, expectedSha256: declaration.sha256, status: 'unknown' };
    files.push(item);
    if (!file) { item.reason = 'Path was not explicitly allowed by --source/--recipe; not read'; continue; }
    try {
      const bytes = reader.bytes(file);
      item.actualSha256 = hash(bytes);
      item.bytes = bytes.length;
      item.status = item.actualSha256 === declaration.sha256 && (declaration.bytes === undefined || declaration.bytes === bytes.length) ? 'verified' : 'stale';
    } catch (error) { item.status = runtimeErrorCode(error) === 'ENOENT' ? 'missing' : 'invalid'; item.reason = runtimeErrorMessage(error); }
  }
  return { status: files.every((item) => item.status === 'verified') ? 'verified'
    : files.some((item) => item.status === 'stale') ? 'stale' : 'unknown', files,
  coverage: 'Only explicitly declared and allowed files; no claim of complete generator dependencies' };
}

function assetEvidence(reader: { root?: string; bytes?: (file: unknown,limit?: number) => unknown; fingerprint: unknown; json?: (file: string) => unknown; list?: (directory: string) => unknown[]; evidence?: () => ({ scope: unknown; file: unknown; status: unknown; sha256: unknown; bytes: unknown; }|{ scope: unknown; file: unknown; kind: string; sha256: string; })[]; verify?: () => string[]; }, file: string, declared: never) {
  try {
    const { bytes, sha256 } = reader.fingerprint(file, 64 * 1024 * 1024);
    return { status: !declared ? 'unverified' : declared.sha256 === sha256 && declared.bytes === bytes ? 'verified' : 'mismatch',
      file, bytes, sha256, imageQuality: 'unverified' };
  } catch (error) { return { status: runtimeErrorCode(error) === 'ENOENT' ? 'missing' : 'invalid', file, reason: runtimeErrorMessage(error), imageQuality: 'unverified' }; }
}

function publicationState(record: { key: string|number; runId: unknown; recordId: unknown; inputVersion: unknown; asset: { sha256: unknown; bytes: unknown; }; }, item: { key?: unknown; recordId?: unknown; recordSha256: unknown; inputVersion?: unknown; structure?: string; generation?: unknown; source?: { status: string; files: { role: unknown; file: unknown; expectedSha256: unknown; status: string; }[]; coverage: string; }; payload?: { status: string; actualSha256: string; expectedSha256: unknown; }; version?: { status: string; reason: string; expected?: undefined; actual?: undefined; rule?: undefined; }|{ status: string; expected: string; actual: unknown; rule: string; reason?: undefined; }; asset?: { status: string; file: string; bytes: unknown; sha256: unknown; imageQuality: string; reason?: undefined; }|{ status: string; file: string; reason: string; imageQuality: string; bytes?: undefined; sha256?: undefined; }; freshness?: string; review: unknown; }, publication: { schemaVersion: number; kind: string; records: { [x: string]: unknown; }|null; runId: unknown; manifestSha256: unknown; reviewSha256: unknown; }|null, publishedReader: { root: string; bytes(file: unknown,limit?: number): unknown; fingerprint(file: unknown,limit: number|undefined): { bytes: unknown; sha256: unknown; }; json(file: string): unknown; list(directory: string): unknown[]; evidence(): ({ scope: unknown; file: unknown; status: unknown; sha256: unknown; bytes: unknown; }|{ scope: unknown; file: unknown; kind: string; sha256: string; })[]; verify(): string[]; }|null, bindings: { manifestSha256: unknown; decisionSha256: unknown; }) {
  if (!publication) return { status: 'not-provided', activation: 'unknown' };
  if (!object(publication) || publication.schemaVersion !== 1 || publication.kind !== 'content-publication-evidence' || !object(publication.records)) {
    return { status: 'unknown', reason: 'Unsupported publication format; use its dedicated release audit', activation: 'unknown' };
  }
  const receipt = publication.records[record.key];
  if (!receipt) return { status: 'not-listed', activation: 'unknown' };
  if (!object(receipt) || typeof receipt.publishedAt !== 'string' || !Number.isFinite(Date.parse(receipt.publishedAt))
    || !SHA.test(receipt.sha256) || !Number.isSafeInteger(receipt.bytes) || receipt.bytes <= 0) return { status: 'invalid', activation: 'unknown' };
  let file;
  try { file = evidencePath(receipt.path); } catch (error) { return { status: 'invalid', reason: runtimeErrorMessage(error), activation: 'unknown' }; }
  const asset = publishedReader ? assetEvidence(publishedReader, file, receipt) : { status: 'unknown', reason: '--published-root not provided; no published file accessed' };
  const same = publication.runId === record.runId && publication.manifestSha256 === bindings.manifestSha256
    && !!bindings.decisionSha256 && publication.reviewSha256 === bindings.decisionSha256
    && receipt.recordId === record.recordId && receipt.recordSha256 === item.recordSha256
    && receipt.inputVersion === record.inputVersion && receipt.sha256 === record.asset?.sha256 && receipt.bytes === record.asset?.bytes;
  return { status: !same || item.review.status !== 'approved' ? 'stale' : asset.status === 'verified' ? 'evidence-verified'
    : ['mismatch', 'missing', 'invalid'].includes(asset.status) ? 'invalid' : 'unknown',
  publishedAt: receipt.publishedAt, asset, activation: 'unknown',
  reason: 'Only explicit local receipt/bytes verified; no publication performed or service activation inferred' };
}

function auditContentEvidence(options: { candidateRoot: unknown; root: PathLike; publishedRoot: PathLike; manifest: string; expectManifestSha256: string; decisions: string; publication: string; }) {
  const result = { schemaVersion: 1, kind: 'content-evidence-audit', readOnly: true, executed: true,
    structure: { status: 'unknown' }, items: [], errors: [], unknown: [], evidence: [], exitCode: 3,
    acceptance: { imageQuality: 'unverified', reviewerAuthenticity: 'unverified', publicationPerformed: false, wholeLibrary: 'not-validated' } };
  const readers = [];
  try {
    const candidates = evidenceReader(options.candidateRoot || options.root, 'candidate'); readers.push(candidates);
    const sources = evidenceReader(options.root, 'source'); readers.push(sources);
    const published = options.publishedRoot ? evidenceReader(options.publishedRoot, 'published') : null;
    if (published) readers.push(published);
    const manifestFile = evidencePath(options.manifest);
    const directory = path.posix.dirname(manifestFile);
    const nearby = (file: string) => path.posix.join(directory, evidencePath(file));
    const name = path.posix.basename(manifestFile);
    const match = /^(?:(reference|popular|scene)-)?generation-manifest\.json$/.exec(name);
    if (!match) throw new Error('Use an explicit generation-manifest.json or batch-generation-manifest.json');
    const batch = match[1] || null;
    const raw = candidates.bytes(manifestFile);
    const manifestSha256 = hash(raw);
    result.manifest = { file: manifestFile, sha256: manifestSha256 };
    if (options.expectManifestSha256 && options.expectManifestSha256 !== manifestSha256) throw new Error('Explicit manifest SHA-256 does not match');
    const records = candidates.json(manifestFile);
    const marker = candidates.json(nearby('candidate-run.json'));
    if (!object(marker) || marker.kind !== 'generation-candidates' || marker.schemaVersion !== 1 || !UUID.test(marker.runId)
      || typeof marker.generator !== 'string') throw new Error('Invalid candidate run marker');
    if (!Array.isArray(records) || records.length > 100000) throw new Error('Invalid candidate manifest container');
    const identities = new Set(), candidatesSeen = new Set(), attempts = new Set(), latest = new Map();
    for (const record of records) {
      validateRecord(record, marker);
      if (batch && record.batch !== batch) throw new Error('Batch manifest contains another batch');
      if (identities.has(record.recordId) || candidatesSeen.has(record.candidateId) || attempts.has(`${record.key}@${record.attempt}`)) throw new Error('Duplicate candidate identity or ambiguous attempt');
      identities.add(record.recordId); candidatesSeen.add(record.candidateId); attempts.add(`${record.key}@${record.attempt}`);
      const ledger = candidates.json(nearby(`records/${record.candidateId}.json`));
      if (!equal(ledger, record)) throw new Error('Manifest differs from authoritative candidate record');
      if (!latest.has(record.key) || latest.get(record.key).attempt < record.attempt) latest.set(record.key, record);
    }
    // Exports must not conceal a newer attempt. Other batch ledgers are validated
    // for identity, but are never interpreted as selected assets or decisions.
    const names = candidates.list(nearby('records'));
    if (names.length > 100000) throw new Error('Candidate ledger exceeds entry limit');
    for (const name of names.filter((file) => file.endsWith('.json'))) {
      if (!UUID.test(name.slice(0, -5))) throw new Error('Unrecognized authoritative record filename');
      const ledger = candidates.json(nearby(`records/${name}`));
      validateRecord(ledger, marker);
      if (name !== `${ledger.candidateId}.json`) throw new Error('Ledger filename and candidate ID differ');
      if ((!batch || ledger.batch === batch) && !identities.has(ledger.recordId)) throw new Error('Candidate manifest omits authoritative records');
    }
    let decisions = null, decisionSha256 = null;
    if (options.decisions) {
      decisions = validateDecisions(candidates.json(options.decisions));
      decisionSha256 = hash(candidates.bytes(options.decisions));
      if (Object.keys(decisions.records).some((key) => !latest.has(key))) result.unknown.push('Decision file includes identities not in the selected candidate manifest');
    }
    const publication = options.publication ? candidates.json(options.publication) : null;
    result.structure.status = 'passed';
    for (const record of latest.values()) {
      const source = sourceEvidence(record, sources, options);
      const payload = { status: jsonHash(record.payload) === record.payloadSha256 ? 'verified' : 'mismatch',
        actualSha256: jsonHash(record.payload), expectedSha256: record.payloadSha256 };
      const version = inputVersion(record);
      const asset = assetEvidence(candidates, nearby(record.image), record.asset);
      const freshness = source.status === 'stale' ? 'stale'
        : source.status === 'verified' && payload.status === 'verified' && version.status === 'verified' && asset.status === 'verified' ? 'current' : 'unknown';
      const item = { key: record.key, recordId: record.recordId, recordSha256: jsonHash(record), inputVersion: record.inputVersion,
        structure: 'passed', generation: record.status, source, payload, version, asset, freshness,
        review: reviewState(record, record.status === 'succeeded' ? freshness : 'unknown', decisions, manifestSha256, marker.runId) };
      item.publication = publicationState(record, item, publication, published, { manifestSha256, decisionSha256 });
      result.items.push(item);
    }
    if (!records.length) result.unknown.push('Empty candidate manifest does not prove completed assets');
  } catch (error) { result.structure.status = 'invalid'; result.errors.push(runtimeErrorMessage(error)); }
  const drift = readers.flatMap((reader) => reader.verify());
  result.evidence = readers.flatMap((reader) => reader.evidence());
  result.unknown.push(...drift);
  if (drift.length) for (const item of result.items) {
    item.freshness = 'stale';
    if (['approved', 'rejected'].includes(item.review.status)) item.review.status = 'stale';
    if (item.publication.status === 'evidence-verified') item.publication.status = 'stale';
  }
  const failed = result.errors.length || result.items.some((item) => item.payload.status === 'mismatch' || item.version.status === 'mismatch'
    || ['mismatch', 'invalid'].includes(item.asset.status) || (item.generation === 'succeeded' && item.asset.status === 'missing')
    || ['invalid', 'rejected'].includes(item.review.status) || item.publication.status === 'invalid'
    || ['mismatch', 'missing', 'invalid'].includes(item.publication.asset?.status));
  const unresolved = result.unknown.length || !result.items.length || result.items.some((item) => item.freshness !== 'current'
    || item.generation !== 'succeeded' || item.review.status !== 'approved'
    || !['not-provided', 'evidence-verified'].includes(item.publication.status));
  result.exitCode = failed ? 1 : unresolved ? 3 : 0;
  result.status = failed ? 'failed' : unresolved ? 'requires-revalidation' : 'evidence-verified';
  return result;
}

export = { auditContentEvidence, sourceEvidence, assetEvidence, publicationState };

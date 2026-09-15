import { errorMessage as runtimeErrorMessage } from './runtime-errors';
'use strict';

// Candidate integrity and human decisions are separate evidence. This module
// never calls a model, edits a candidate, or decides whether an image is good.
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { CODE_ROOT, hash, noLinks }: typeof import('./generation-candidates') = require('./generation-candidates');
const { validatePng }: typeof import('./generation-gateway') = require('./generation-gateway');

const GENERATOR = 'render-all-outfits-references.js';
const SOURCE = 'data/character-reference-standards.json';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const SHA = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9-]{36}$/;
const jsonHash = (value: any) => hash(JSON.stringify(value));

function bytes(file: any, max = 64 * 1024 * 1024) {
  noLinks(file);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) throw new Error('Expected a bounded, ordinary file: ' + file);
  return fs.readFileSync(file);
}

function json(file: any) { return JSON.parse(bytes(file).toString('utf8')); }
function within(root: any, file: any) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
}

function relativeImage(value: any) {
  if (typeof value !== 'string' || value.includes('\\') || value.includes('%') || value.includes(':')) throw new Error('Unsafe reference image path');
  const parts = value.split('/');
  if (parts.length < 2 || !/\.(png|webp|jpg|jpeg)$/i.test(parts.at(-1))
      || parts.some(part => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(part) || part === '..' || /[. ]$/.test(part)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe reference image path: ' + value);
  return value;
}

function verifyRecord(record: any, marker: any) {
  if (!record || record.schemaVersion !== 1 || record.batch !== 'reference' || record.generator !== GENERATOR
      || record.runId !== marker.runId || !uuid.test(record.candidateId)
      || !Number.isSafeInteger(record.attempt) || record.attempt < 1
      || ![record.characterId, record.outfitId, record.persId].every(value => typeof value === 'string' && ID.test(value))
      || record.key !== `reference:${record.characterId}:${record.outfitId}:${record.persId}`
      || record.recordId !== `${record.key}@attempt-${record.attempt}-${record.candidateId}`
      || record.image !== `images/${record.candidateId}.png`
      || record.intendedReferencePath !== `${record.characterId}/${record.outfitId}/${record.persId}.png`
      || !SHA.test(record.inputVersion) || !record.payload || jsonHash(record.payload) !== record.payloadSha256
      || record.review?.verdict !== 'pending' || record.review.recordId !== record.recordId
      || record.review.reviewedAt || record.publishedAt) throw new Error('Invalid reference candidate identity/evidence');
  relativeImage(record.intendedReferencePath);
}

function currentInput(record: any, root: any) {
  // Never follow arbitrary file paths embedded in an imported ledger.
  const source = path.join(root, SOURCE);
  const recipe = path.join(CODE_ROOT, 'scripts/maintenance', GENERATOR);
  if (!Array.isArray(record.sources) || record.sources.length !== 1
      || path.resolve(record.sources[0].path || '') !== path.resolve(source)
      || path.resolve(record.recipeSource?.path || '') !== path.resolve(recipe)) return false;
  const actual = bytes(source);
  if (record.sources[0].sha256 !== hash(actual) || record.sources[0].bytes !== actual.length
      || record.recipeSource.sha256 !== hash(bytes(recipe))) return false;
  const { seed: _seed, ...recipePayload } = record.payload;
  const metadata = {
    batch: 'reference', engine: 'anima', characterId: record.characterId,
    charName: record.charName, outfitId: record.outfitId, outfitName: record.outfitName,
    persId: record.persId, persName: record.persName, intendedReferencePath: record.intendedReferencePath,
  };
  return jsonHash({ sources: record.sources, recipeSource: record.recipeSource, key: record.key, metadata, recipe: recipePayload }) === record.inputVersion;
}

function inspectCandidates({ from, root = CODE_ROOT }: any) {
  const manifestFile = path.resolve(from);
  const directory = path.dirname(manifestFile);
  if (!['generation-manifest.json', 'reference-generation-manifest.json'].includes(path.basename(manifestFile))) throw new Error('Use an explicit reference candidate manifest');
  const marker = json(path.join(directory, 'candidate-run.json'));
  if (marker.kind !== 'generation-candidates' || marker.schemaVersion !== 1 || marker.generator !== GENERATOR || !uuid.test(marker.runId)) throw new Error('Unrecognized reference candidate directory');
  const raw = bytes(manifestFile);
  const records = JSON.parse(raw.toString('utf8'));
  if (!Array.isArray(records) || records.length > 100000) throw new Error('Invalid candidate manifest');
  const ids = new Set();
  const ledgerIds = new Set();
  const latest = new Map();
  for (const record of records) {
    verifyRecord(record, marker);
    if (ids.has(record.recordId)) throw new Error('Duplicate candidate record');
    ids.add(record.recordId);
    ledgerIds.add(`${record.candidateId}.json`);
    const ledger = json(path.join(directory, 'records', `${record.candidateId}.json`));
    if (jsonHash(ledger) !== jsonHash(record)) throw new Error('Manifest and authoritative candidate record differ');
    const previous = latest.get(record.key);
    if (previous?.attempt === record.attempt) throw new Error('Ambiguous candidate attempt');
    if (!previous || previous.attempt < record.attempt) latest.set(record.key, record);
  }
  // A stale exported manifest must not hide a newer authoritative attempt.
  const ledgerNames = fs.readdirSync(noLinks(path.join(directory, 'records'))).filter(name => name.endsWith('.json'));
  if (ledgerNames.length !== records.length || ledgerNames.some(name => !ledgerIds.has(name))) throw new Error('Candidate manifest omits authoritative records');
  const items = [...latest.values()].sort((a, b) => a.key.localeCompare(b.key)).map(record => {
    let integrity = 'pending';
    let reason = record.status === 'succeeded' ? '' : 'Generation has not succeeded';
    try {
      if (!currentInput(record, root)) { integrity = 'stale'; reason = 'Source or generation recipe changed'; }
      else if (record.status === 'succeeded') {
        const image = bytes(path.join(directory, record.image));
        validatePng(image);
        if (record.asset?.sha256 !== hash(image) || record.asset?.bytes !== image.length || record.asset?.path !== record.image) throw new Error('Candidate bytes differ from generated evidence');
        integrity = 'pass';
      }
    } catch (error) { integrity = 'invalid'; reason = runtimeErrorMessage(error); }
    return { key: record.key, recordId: record.recordId, inputVersion: record.inputVersion, recordSha256: jsonHash(record),
      sha256: record.asset?.sha256 || null, image: record.image, intendedReferencePath: record.intendedReferencePath,
      integrity, reason, review: 'pending' };
  });
  return { schemaVersion: 1, kind: 'reference-candidate-inspection', runId: marker.runId,
    manifestSha256: hash(raw), sourceRoot: path.resolve(root), items, records,
    directory, sourceFile: path.join(path.resolve(root), SOURCE), review: 'pending' };
}

function collectReview(inspection: any, decisions: any, decisionSource: any) {
  if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) throw new Error('Decisions must be an object keyed by reference identity');
  const items = new Map(inspection.items.map((item: any) => [item.key, item]));
  const reviewed = {};
  for (const [key, decision] of Object.entries(decisions)) {
    const item = items.get(key);
    if (!item || item.integrity !== 'pass' || !decision || !['pass', 'fail'].includes(decision.verdict)
        || decision.recordId !== item.recordId || decision.sha256 !== item.sha256
        || decision.inputVersion !== item.inputVersion || typeof decision.reviewedAt !== 'string'
        || !Number.isFinite(Date.parse(decision.reviewedAt))) throw new Error('Decision must identify the current verified image, source version and review time: ' + key);
    reviewed[key] = { verdict: decision.verdict, recordId: item.recordId, recordSha256: item.recordSha256,
      sha256: item.sha256, inputVersion: item.inputVersion, reviewedAt: decision.reviewedAt,
      notes: typeof decision.notes === 'string' ? decision.notes : '' };
  }
  return { schemaVersion: 1, kind: 'reference-human-review', runId: inspection.runId,
    manifestSha256: inspection.manifestSha256, decisionSource, recordedAt: new Date().toISOString(), records: reviewed,
    pending: inspection.items.filter((item: any) => !reviewed[item.key]).map((item: any) => item.key) };
}

function attachReview(inspection: any, review: any) {
  if (!review || review.schemaVersion !== 1 || review.kind !== 'reference-human-review'
      || review.runId !== inspection.runId || review.manifestSha256 !== inspection.manifestSha256
      || !review.records || typeof review.records !== 'object' || Array.isArray(review.records)) throw new Error('Review is missing or belongs to a different candidate version');
  if (Object.keys(review.records).some(key => !inspection.items.some((item: any) => item.key === key))) throw new Error('Review contains unknown candidates');
  return inspection.items.map((item: any) => {
    const decision = review.records[item.key];
    if (!decision) return { ...item, review: 'pending' };
    if (!['pass', 'fail'].includes(decision.verdict) || !Number.isFinite(Date.parse(decision.reviewedAt))
        || ['recordId', 'recordSha256', 'sha256', 'inputVersion'].some(key => decision[key] !== item[key])) throw new Error('Review evidence no longer matches candidate: ' + item.key);
    return { ...item, review: item.integrity === 'pass' ? decision.verdict : 'stale' };
  });
}

function saveReview(inspection: any, output: any, review: any) {
  const target = path.resolve(output);
  if (!within(inspection.directory, target) || !/^manual-review(?:-[a-zA-Z0-9_-]+)?\.json$/.test(path.basename(target))
      || path.dirname(target) !== inspection.directory) throw new Error('Review output must be a new manual-review*.json beside the candidate manifest');
  noLinks(target);
  fs.writeFileSync(target, JSON.stringify(review, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return target;
}

export = { GENERATOR, SOURCE, SHA, bytes, json, within, relativeImage, jsonHash,
  inspectCandidates, collectReview, attachReview, saveReview };

#!/usr/bin/env node
'use strict';

/**
 * Build manual-review.json from a reviewer decisions file.
 *
 * decisions.json shape (every reviewed image needs an explicit decision):
 *   { "scene:sc001": { verdict: 'pass', recordId: '...', notes: '...' }, ... }
 *
 * Missing decisions stay pending and are omitted from passing records. A
 * decision is bound to its reviewed recordId, never transferred to a retry.
 *
 * Usage:
 *   node scripts/maintenance/build-scene-manual-review.js \
 *       [--manifest <generation-manifest.json>] [--decisions <decisions.json>] \
 *       [--out manual-review.json] [--latest-attempt]
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

function argument(name: string, fallback: any = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function buildReview(records: unknown[], decisions: { [s: string]: unknown; }|ArrayLike<unknown>, { latestOnly = false, reviewedAt = new Date().toISOString() }: any = {}) {
  if (!Array.isArray(records)) throw new Error('manifest must be an array');
  if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) throw new Error('decisions must be an object');
  const succeeded = records.filter((record: any) => record && record.status === 'succeeded');
  const byId = new Map();
  const latest = new Map();
  for (const record of succeeded) {
    if (!record.key || !record.recordId || byId.has(record.recordId)) throw new Error('missing or duplicate successful recordId');
    byId.set(record.recordId, record);
    const previous = latest.get(record.key);
    if (!previous || Number(record.attempt) > Number(previous.attempt)) latest.set(record.key, record);
  }
  const recordsOut = Object.create(null);
  for (const [key, decision] of Object.entries(decisions)) {
    if (!decision || !['pass', 'fail'].includes(decision.verdict)) throw new Error(`invalid decision for ${key}`);
    const record = byId.get(decision.recordId);
    if (!record || record.key !== key) throw new Error(`decision for ${key} must identify its succeeded recordId`);
    if (latestOnly && latest.get(key).recordId !== record.recordId) throw new Error(`decision for ${key} is not for the latest successful attempt`);
    recordsOut[key] = { verdict: decision.verdict, recordId: record.recordId, notes: decision.notes || '', reviewedAt };
  }
  const pending = [...latest.keys()].filter((key: any) => !Object.hasOwn(recordsOut, key));
  return { version: 1, reviewedAt, records: recordsOut, pending };
}

function main() {
  const manifestArg = argument('--manifest');
  const decisionsArg = argument('--decisions');
  if (!manifestArg || !decisionsArg) throw new Error('--manifest and --decisions are required');
  const manifestPath = path.resolve(manifestArg);
  const decisionsPath = path.resolve(decisionsArg);
  const outPath = path.resolve(argument('--out', path.join(path.dirname(manifestPath), 'manual-review.json')));
  const latestOnly = process.argv.includes('--latest-attempt');

  const records = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const decisions = JSON.parse(fs.readFileSync(decisionsPath, 'utf8'));
  const output = buildReview(records, decisions, { latestOnly });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const temporary = `${outPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, outPath);
  const counts: any = { pass: 0, fail: 0 };
  for (const entry of Object.values(output.records)) counts[entry.verdict] += 1;
  console.log(JSON.stringify({ out: outPath, reviewed: Object.keys(output.records).length, pending: output.pending.length, counts }, null, 2));
}

if (require.main === module) {
  main();
}

export = { main, buildReview };

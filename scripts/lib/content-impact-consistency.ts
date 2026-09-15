import { errorMessage as runtimeErrorMessage } from './runtime-errors';
'use strict';
const { loadDomain }: typeof import('./content-history-snapshot') = require('./content-history-snapshot');
const { compareReferenceProjection }: typeof import('../maintenance/content-impact-references') = require('../maintenance/content-impact-references');

// Only import pure inspection functions. In particular do not import builders,
// stores with a process-global root, or the production-data contract test suite.
function inspectDomain(reader: any, domain: PropertyKey) {
  const snapshot = loadDomain(reader, domain);
  if (domain === 'references') {
    try {
      const check: any = compareReferenceProjection(reader.json('data/character-reference-standards.json'), reader.json('data/character-reference-view.json'));
      snapshot.checks.push(check);
      snapshot.issues.push(...check.issues);
      if (check.status === 'unknown') { snapshot.complete = false; snapshot.unknown.push(check.reason); }
    } catch (error) { snapshot.complete = false; snapshot.unknown.push(runtimeErrorMessage(error)); }
  }
  return snapshot;
}

function summarizeConsistency(snapshot: any) {
  return { domain: snapshot.domain, status: snapshot.issues.length ? 'mismatch' : !snapshot.complete ? 'unknown'
    : snapshot.checks.length ? 'current' : 'not-derived',
  scope: 'Explicit JSON projections/fields only; no build, rendering or full-library validation',
  groups: Object.entries(snapshot.groups).map(([name, group]: any) => ({ name, complete: group.complete })),
  checks: snapshot.checks, issues: snapshot.issues, unknown: snapshot.unknown,
  untracked: ['compressed products', 'DATA_VERSION', 'schema/semantic validation', 'asset existence and review authenticity'] };
}

export = { inspectDomain, summarizeConsistency };
